/**
 * Telemetry receiver — single endpoint, single table.
 *
 *   POST /v1/ping
 *
 * Hashes (week-bucket-salt || client_ip || installation_id) once, stores
 * (week_bucket, hash, dashboard_version, heliosdb_version, received_at).
 * The raw IP and the raw installation_id are not written anywhere.
 *
 * No external dependencies beyond Fastify + pg. Salt is held in memory
 * and rotated by a weekly cron that restarts this process.
 */

import Fastify from 'fastify';
import pg from 'pg';
import { createHash, randomBytes } from 'crypto';
import { readFile } from 'fs/promises';

const PORT = Number(process.env.PORT || 4080);
const SALT_FILE = process.env.SALT_FILE || '/run/telemetry/salt';
const PG_URL = process.env.PG_URL || 'postgres://telemetry@localhost/telemetry';

const pool = new pg.Pool({ connectionString: PG_URL });

/**
 * Schema bootstrap. HeliosDB-Nano has no docker-entrypoint init-dir, so
 * we run CREATE TABLE IF NOT EXISTS from the receiver itself on first
 * connect. Idempotent. Retries with backoff because the DB may not be
 * ready yet when this container starts.
 */
async function ensureSchema(retries = 30) {
  // HeliosDB-Nano rejects multi-statement queries with
  //   "Multiple statements not supported in single query"
  // (logged as Bug #7 in claude-dashboard:docs/heliosdb-bugs.md), so
  // we send each DDL separately. Each is idempotent.
  const ddls = [
    `CREATE TABLE IF NOT EXISTS pings (
       week_bucket        TEXT NOT NULL,
       hash               TEXT NOT NULL,
       dashboard_version  TEXT NOT NULL,
       heliosdb_version   TEXT,
       received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (week_bucket, hash)
     )`,
    `CREATE INDEX IF NOT EXISTS pings_week_idx ON pings (week_bucket)`,
    `CREATE INDEX IF NOT EXISTS pings_received_idx ON pings (received_at)`,
  ];
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      for (const stmt of ddls) await pool.query(stmt);
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 5000)));
    }
  }
}

async function loadSalt() {
  try {
    return (await readFile(SALT_FILE, 'utf8')).trim();
  } catch {
    // No salt file yet — generate one in memory only. Operators should
    // run salt-rotate.cron to persist a sealed weekly salt.
    return randomBytes(32).toString('hex');
  }
}

await ensureSchema();
const SALT = await loadSalt();

function isoWeekBucket(d = new Date()) {
  // ISO-8601 week, returns "YYYY-WW".
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

const fastify = Fastify({ logger: true });

// Permit cross-origin reads of the public landing page + /v1/stats. The
// dashboard's per-install /telemetry page renders the headline count
// from the browser, and any other client can do the same.
fastify.addHook('onSend', async (_req, reply, payload) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type');
  return payload;
});
fastify.options('/v1/*', async (_req, reply) => reply.code(204).send());
fastify.options('/', async (_req, reply) => reply.code(204).send());

/**
 * Shared core: validate, hash, insert, return ok-ness. Used by both the
 * POST /v1/ping (programmatic) and GET /v1/ping (browser-paste) paths.
 */
async function recordPing(req, body) {
  const ip = req.ip;
  const id = body?.installation_id;
  const dv = body?.dashboard_version;
  const hv = body?.heliosdb_version || null;

  if (typeof id !== 'string' || !/^[a-f0-9]{16,64}$/.test(id)) {
    return { code: 400, error: 'invalid installation_id' };
  }
  if (typeof dv !== 'string' || dv.length === 0 || dv.length > 64) {
    return { code: 400, error: 'invalid dashboard_version' };
  }

  const week = isoWeekBucket();
  const hash = createHash('sha256').update(`${SALT}|${week}|${ip}|${id}`).digest('hex');

  try {
    await pool.query(
      `INSERT INTO pings (week_bucket, hash, dashboard_version, heliosdb_version)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (week_bucket, hash) DO NOTHING`,
      [week, hash, dv, hv]
    );
  } catch (err) {
    req.log.error({ err }, 'pings insert failed');
    return { code: 500, error: 'storage failure' };
  }

  return { code: 200, ok: true, week };
}

fastify.post('/v1/ping', async (req, reply) => {
  const r = await recordPing(req, req.body || {});
  if (r.code !== 200) return reply.code(r.code).send({ error: r.error });
  return { ok: true };
});

/**
 * GET /v1/ping?installation_id=...&dashboard_version=...&heliosdb_version=...&timestamp=...
 *
 * Browser-paste path for restricted-egress operators: when an air-gapped
 * dashboard generates a URL via /telemetry, the operator copies it and
 * pastes into any browser on a machine with internet access. Records the
 * ping identically to the POST path and returns a tiny human-readable
 * success page (or an error page on validation failure).
 *
 * The `timestamp` query param is accepted for parity with the POST body
 * but isn't used for dedupe (which keys on week_bucket + hash).
 */
fastify.get('/v1/ping', async (req, reply) => {
  const q = req.query || {};
  const r = await recordPing(req, {
    installation_id: q.installation_id,
    dashboard_version: q.dashboard_version,
    heliosdb_version: q.heliosdb_version,
  });
  reply.type('text/html');
  if (r.code !== 200) {
    reply.code(r.code);
    return `<!doctype html><meta charset=utf-8>
<title>telemetry · ${r.code}</title>
<body style="font-family:ui-monospace,Menlo,monospace;background:#0b0d10;color:#f85149;
            margin:0;padding:3rem 1.5rem">
<main style="max-width:560px;margin:0 auto">
<h1 style="margin:0 0 .5rem">Submission rejected</h1>
<p>HTTP ${r.code} · <code>${r.error}</code></p>
<p><a style="color:#79c0ff" href="/">back</a></p></main>`;
  }
  return `<!doctype html><meta charset=utf-8>
<title>telemetry · received</title>
<body style="font-family:ui-monospace,Menlo,monospace;background:#0b0d10;color:#e6edf3;
            margin:0;padding:3rem 1.5rem">
<main style="max-width:560px;margin:0 auto">
<h1 style="color:#3fb950;margin:0 0 .5rem">Ping received ✓</h1>
<p>Counted in week <code style="color:#79c0ff">${r.week}</code>. You can close this tab.</p>
<p style="color:#8b949e;font-size:.85rem">No identifying information was stored. The
receiver hashes <code>(weekly_salt || your_ip || installation_id)</code> and keeps
only the hash. Salt rotates weekly so the hash can't be cross-correlated across
weeks.</p>
<p><a style="color:#79c0ff" href="/v1/stats">/v1/stats</a> ·
   <a style="color:#79c0ff" href="/">about</a></p></main>`;
});

fastify.get('/v1/stats', async () => {
  // HeliosDB-Nano Bug #8: parameterised SELECT (`WHERE col = $1`)
  // returns malformed RowDescription and crashes node-pg. The
  // `week` value below is generated by isoWeekBucket() and is
  // guaranteed to match `^\d{4}-\d{2}$` — no injection surface, so
  // literal interpolation is safe here. Re-introduce $1 once
  // upstream fixes the extended-protocol path.
  // HeliosDB-Nano Bug #10: column alias is dropped on aggregate
  // expressions (`COUNT(*) AS x` returns column `count`). Read the
  // returned key, not our requested alias. Re-introduce aliases when
  // upstream is fixed.
  const week = isoWeekBucket();
  if (!/^\d{4}-\d{2}$/.test(week)) throw new Error('bad week bucket');
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT hash) FROM pings WHERE week_bucket = '${week}'`
  );
  const { rows: byVersion } = await pool.query(
    `SELECT dashboard_version, COUNT(DISTINCT hash)
       FROM pings
      WHERE week_bucket = '${week}'
      GROUP BY dashboard_version`
  );
  return {
    week,
    installs: Number(rows[0]?.count || 0),
    byVersion: byVersion
      .map((r) => ({ version: r.dashboard_version, installs: Number(r.count) }))
      .sort((a, b) => b.installs - a.installs),
  };
});

// Tiny public landing page. The per-install /telemetry page on each
// dashboard explains what gets sent; this one explains who's collecting
// it. No tracker, no JS, single HTML response.
fastify.get('/', async (_req, reply) => {
  reply.type('text/html');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>telemetry.danimoya.com</title>
<style>
  body{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0b0d10;color:#e6edf3;
       margin:0;padding:3rem 1.5rem;line-height:1.55}
  main{max-width:720px;margin:0 auto}
  h1{font-size:1.6rem;margin:0 0 .5rem;letter-spacing:-.02em}
  h2{font-size:1.05rem;color:#79c0ff;margin:2rem 0 .5rem}
  p,li{font-size:.94rem}
  code{color:#79c0ff}
  pre{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:.9rem 1rem;
      overflow-x:auto;font-size:.85rem}
  a{color:#79c0ff}
  .footer{color:#8b949e;font-size:.8rem;margin-top:3rem;border-top:1px solid #30363d;
          padding-top:1rem}
</style></head>
<body><main>
<h1>telemetry.danimoya.com</h1>
<p>Anonymous install-count receiver for Claude-Dashboard, Claude-B, and
related projects. <strong>Opt-in, off by default.</strong></p>

<h2>What this is</h2>
<p>Each dashboard install can voluntarily POST four fields to
<code>/v1/ping</code> once a week:</p>
<pre>{ "installation_id":  "<random hex>",
  "dashboard_version": "1.4.2",
  "heliosdb_version":  "3.19.1",
  "timestamp":         "2026-05-03T12:34:56Z" }</pre>

<p>The receiver hashes <code>(weekly_salt, client_ip, installation_id)</code>
and stores only the hash + version columns. Raw IP and the raw
<code>(ip, id)</code> tuple are never persisted. Salt rotates weekly so
hashes from week N can't be cross-correlated with hashes from week N+1.</p>

<h2>Endpoints</h2>
<ul>
  <li><code>POST /v1/ping</code> — submit a ping (called by the dashboards)</li>
  <li><code>GET  /v1/stats</code> — weekly aggregate count, public</li>
</ul>

<h2>Source</h2>
<p>Receiver source, schema, salt-rotation cron, and append-only audit
changelog: <a href="https://github.com/danimoya/telemetry">github.com/danimoya/telemetry</a>.</p>

<h2>Per-install transparency</h2>
<p>Each running dashboard exposes its own <code>/telemetry</code> page
showing exactly what that install would send. Read that page on your own
deployment before deciding whether to opt in.</p>

<p class="footer">Operated by Daniel Moya. Apache-2.0. Last
salt rotation: ${isoWeekBucket()}.</p>
</main></body></html>`;
});

fastify.listen({ host: '0.0.0.0', port: PORT });
