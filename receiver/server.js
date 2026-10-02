/**
 * Telemetry receiver — single endpoint, single table.
 *
 *   POST /v1/ping
 *
 * Hashes (week-bucket-salt || client_ip || installation_id) once, stores
 * (week_bucket, hash, dashboard_version, heliosdb_version, received_at).
 * The raw IP and the raw installation_id are not written anywhere.
 *
 * No external dependencies beyond Fastify + pg. The salt is persisted per
 * ISO week at SALT_FILE (persisted-salt.js) and replaced by a fresh random
 * salt on the first ping of each new week.
 */

import Fastify from 'fastify';
import pg from 'pg';
import { createHash } from 'crypto';
import { createWeeklySalt } from './persisted-salt.js';
import { pathToFileURL } from 'url';

// Canonical ISO-week-bucket shape. The only values ever interpolated
// into raw SQL text (see Bug #8 workaround below) must match this.
export const WEEK_BUCKET_RE = /^\d{4}-\d{2}$/;

/**
 * Guard for every value that gets literally interpolated into a SQL
 * string as part of the HeliosDB-Nano Bug #8 workaround (parameterised
 * SELECTs crash, so week buckets are inlined). Throws unless the value
 * is exactly `YYYY-WW`. Centralised here so the regex guard cannot be
 * silently dropped at one call site while others keep interpolating —
 * every interpolation goes through this one function. Covered by
 * server.test.js, which fails if this stops throwing on bad input.
 */
export function assertWeekBucket(week, label = 'week bucket') {
  if (typeof week !== 'string' || !WEEK_BUCKET_RE.test(week)) {
    throw new Error(`bad ${label}: ${week}`);
  }
  return week;
}

const PORT = Number(process.env.PORT || 4080);
const SALT_FILE = process.env.SALT_FILE || '/run/telemetry/salt';
const PG_URL = process.env.PG_URL || 'postgres://telemetry@localhost/telemetry';

// ── Public-intake rate limiting ────────────────────────────────────
// Both /v1/ping paths are public + unauthenticated. The dedup key is
// (week_bucket, hash) with an attacker-controlled installation_id, so an
// attacker who rotates installation_id (or source IP) can mint unlimited
// distinct rows — inflating the published "weekly active installs" figure
// (metric fraud) and growing the pings table unbounded within a week
// (storage exhaustion). Cap intake per client to a small per-minute
// budget. Self-contained (no new dependency, in line with the receiver's
// "no external deps beyond Fastify + pg" posture); fail-closed: if env is
// missing or malformed, fall back to safe defaults rather than disabling.
function posInt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}
// Max requests per window per client IP for /v1/ping. Defaults: 10/min.
const PING_RL_MAX = posInt(process.env.PING_RATELIMIT_MAX, 10);
const PING_RL_WINDOW_MS = posInt(process.env.PING_RATELIMIT_WINDOW_MS, 60000);
// The receiver sits behind NPM (TLS-terminated edge), so req.socket sees
// the proxy IP. Trust X-Forwarded-For to key the limiter on the real
// client. Disable with TRUST_PROXY=false for a direct-exposure deploy.
const TRUST_PROXY = String(process.env.TRUST_PROXY ?? 'true').toLowerCase() !== 'false';

// Fixed-window counters: clientIp -> { count, resetAt }. Memory is bounded
// by a periodic sweep of expired buckets (window is short, so the live set
// is "distinct client IPs seen in the last window").
const rlBuckets = new Map();
function rateLimitClientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      // Left-most entry is the original client per the XFF convention.
      const first = xff.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.ip;
}
function rateLimitCheck(key, now) {
  const b = rlBuckets.get(key);
  if (!b || now >= b.resetAt) {
    const resetAt = now + PING_RL_WINDOW_MS;
    rlBuckets.set(key, { count: 1, resetAt });
    return { ok: true, remaining: PING_RL_MAX - 1, resetAt };
  }
  if (b.count >= PING_RL_MAX) {
    return { ok: false, remaining: 0, resetAt: b.resetAt };
  }
  b.count += 1;
  return { ok: true, remaining: PING_RL_MAX - b.count, resetAt: b.resetAt };
}
// Sweep expired buckets so the Map can't grow without bound. unref() keeps
// the timer from holding the event loop open at shutdown.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rlBuckets) if (now >= b.resetAt) rlBuckets.delete(k);
}, Math.max(PING_RL_WINDOW_MS, 1000)).unref();

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
       -- Nullable on purpose: one migrated 2026-40 row has no received_at (the pre-2026-10-02
       -- engine did not apply the default). New rows always get now(). Keep in step with
       -- schema.sql and the live table (docs/NANO-4.41-MIGRATION.md).
       received_at        TIMESTAMPTZ DEFAULT now(),
       PRIMARY KEY (week_bucket, hash)
     )`,
    `CREATE INDEX IF NOT EXISTS pings_week_idx ON pings (week_bucket)`,
    `CREATE INDEX IF NOT EXISTS pings_received_idx ON pings (received_at)`,
    // pings_weekly is the kept-forever aggregate. The per-row pings
    // table is pruned at 90 days; finalise-week.sh rolls each completed
    // week into this table so history beyond the retention window
    // survives. Without this, /v1/stats/history would silently lose
    // weeks older than ~13 weeks.
    `CREATE TABLE IF NOT EXISTS pings_weekly (
       week_bucket  TEXT NOT NULL,
       installs     INTEGER NOT NULL,
       finalised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (week_bucket)
     )`,
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

// Weekly salt persisted at SALT_FILE (persisted-salt.js): the same salt for the whole ISO week
// across receiver restarts, a fresh one from the first ping of the next week.
const weeklySalt = createWeeklySalt(SALT_FILE);

// Startup check: reads (or creates) the current week's salt, so a missing or unwritable salt
// volume or a malformed salt file stops the receiver instead of surfacing on the first ping.
async function loadSalt() {
  return weeklySalt.forWeek(isoWeekBucket());
}

export function isoWeekBucket(d = new Date()) {
  // ISO-8601 week, returns "YYYY-WW".
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

// Step backwards by 7 days from the Thursday-of-week anchor; reuse the
// same Thursday-anchoring trick isoWeekBucket() uses so that year
// boundaries (e.g. 2026-W01 sitting in December 2025) come out right.
export function shiftIsoWeek(week, deltaWeeks) {
  const m = /^(\d{4})-(\d{2})$/.exec(week);
  if (!m) throw new Error(`bad week bucket: ${week}`);
  const year = Number(m[1]);
  const weekNo = Number(m[2]);
  // The Thursday of an ISO week always lives inside its labelled year.
  // Anchor at year's Jan 4 (guaranteed to be in W01), then add
  // (weekNo - 1) * 7 days to land in the requested week's Thursday.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const thursday = new Date(jan4);
  thursday.setUTCDate(jan4.getUTCDate() + (weekNo - 1) * 7 + (4 - jan4Day));
  thursday.setUTCDate(thursday.getUTCDate() + deltaWeeks * 7);
  return isoWeekBucket(thursday);
}

// Build an inclusive ascending list of N ISO weeks ending at `endWeek`.
//   weekRangeEndingAt('2026-21', 4) -> ['2026-18','2026-19','2026-20','2026-21']
export function weekRangeEndingAt(endWeek, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push(shiftIsoWeek(endWeek, -i));
  return out;
}

// trustProxy: this receiver always runs behind the NPM (nginx) TLS-
// terminating edge on `management-network`. Without trustProxy, req.ip is
// the proxy's docker IP — a near-constant for every real client — which
// collapses the (salt|week|ip|id) hash onto the client-supplied
// installation_id alone, breaking the dedup/anti-correlation design and
// making the published privacy claim ("hashes your_ip") untrue. With
// trustProxy enabled Fastify resolves req.ip from X-Forwarded-For so the
// real client address is mixed into the hash again. NPM must forward
// X-Forwarded-For (its default). If the edge is ever exposed without a
// trusted proxy in front, narrow this to the proxy's CIDR.
const fastify = Fastify({ logger: true, trustProxy: true });

// Permit cross-origin reads of the public landing page + /v1/stats. The
// dashboard's per-install /telemetry page renders the headline count
// from the browser, and any other client can do the same.
fastify.addHook('onSend', async (_req, reply, payload) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type');
  // Static hardening headers. The HTML pages are server-rendered, JS-free,
  // and use inline <style> + inline <svg>, so a tight CSP is safe:
  //  - default-src 'none'        : nothing loads by default
  //  - style-src 'unsafe-inline' : pages carry inline <style> blocks
  //  - img-src 'self' data:      : allow inline data: images if any
  //  - base-uri 'none'           : no <base> hijacking
  //  - frame-ancestors 'none'    : clickjacking defense (pairs with XFO)
  // nosniff blocks MIME-confusion; no-referrer avoids leaking the URL
  // (the GET /v1/ping browser-paste path carries the installation_id in
  // the query string, so suppressing Referer is a privacy win too).
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; " +
      "base-uri 'none'; frame-ancestors 'none'"
  );
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
  let salt;
  try {
    salt = await weeklySalt.forWeek(week);
  } catch (err) {
    req.log.error({ err }, 'salt unavailable');
    return { code: 500, error: 'storage failure' };
  }
  const hash = createHash('sha256').update(`${salt}|${week}|${ip}|${id}`).digest('hex');

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

// preHandler that enforces the per-client intake budget on both /v1/ping
// paths. Sets standard RateLimit-* headers; on breach returns 429 with a
// Retry-After. `html` controls the breach body so the GET (browser-paste)
// path stays consistent with its themed error page.
function pingRateLimit(html) {
  return async (req, reply) => {
    const key = rateLimitClientIp(req);
    const now = Date.now();
    const res = rateLimitCheck(key, now);
    reply.header('RateLimit-Limit', String(PING_RL_MAX));
    reply.header('RateLimit-Remaining', String(Math.max(res.remaining, 0)));
    reply.header('RateLimit-Reset', String(Math.ceil((res.resetAt - now) / 1000)));
    if (!res.ok) {
      const retryAfter = Math.max(1, Math.ceil((res.resetAt - now) / 1000));
      reply.header('Retry-After', String(retryAfter));
      reply.code(429);
      if (html) {
        reply.type('text/html');
        return reply.send(`<!doctype html><meta charset=utf-8>
<title>telemetry · 429</title>
<body style="font-family:ui-monospace,Menlo,monospace;background:#0b0d10;color:#f85149;
            margin:0;padding:3rem 1.5rem">
<main style="max-width:560px;margin:0 auto">
<h1 style="margin:0 0 .5rem">Too many requests</h1>
<p>HTTP 429 · retry after ${retryAfter}s</p>
<p><a style="color:#79c0ff" href="/">back</a></p></main>`);
      }
      return reply.send({ error: 'rate limit exceeded', retry_after: retryAfter });
    }
  };
}

fastify.post('/v1/ping', { preHandler: pingRateLimit(false) }, async (req, reply) => {
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
fastify.get('/v1/ping', { preHandler: pingRateLimit(true) }, async (req, reply) => {
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
  assertWeekBucket(week);
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

/**
 * Internal: fetch the historical weekly-active series for the most
 * recent `weeks` ISO weeks, ending at the current week. Merges two
 * sources:
 *   - `pings_weekly` (kept forever, populated by finalise-week.sh)
 *   - `pings`        (rolling 90-day raw rows, current+recent weeks)
 * Returns a zero-filled, chronological array of {week, installs}.
 */
async function weeklyHistory(weeks) {
  const currentWeek = isoWeekBucket();
  assertWeekBucket(currentWeek);
  const range = weekRangeEndingAt(currentWeek, weeks);
  const earliest = range[0];

  // Validated by regex on construction (shiftIsoWeek output), but assert
  // before literal interpolation. Belt + braces given Bug #8 workaround.
  assertWeekBucket(earliest, 'earliest week');

  const counts = new Map();
  for (const w of range) counts.set(w, 0);

  // Older buckets (already finalised) from the kept-forever aggregate.
  const { rows: histAgg } = await pool.query(
    `SELECT week_bucket, installs FROM pings_weekly
      WHERE week_bucket >= '${earliest}'`
  );
  for (const r of histAgg) {
    if (counts.has(r.week_bucket)) counts.set(r.week_bucket, Number(r.installs));
  }

  // Recent buckets (within retention) from the raw table — these are
  // authoritative for not-yet-finalised weeks (this week + any week
  // not yet rolled by finalise-week.sh). They overwrite the aggregate
  // value, so a re-run of finalise-week.sh that lands a different
  // count for the current week doesn't drift.
  const { rows: recent } = await pool.query(
    `SELECT week_bucket, COUNT(DISTINCT hash)
       FROM pings
      WHERE week_bucket >= '${earliest}'
      GROUP BY week_bucket`
  );
  for (const r of recent) {
    if (counts.has(r.week_bucket)) counts.set(r.week_bucket, Number(r.count));
  }

  return range.map((w) => ({ week: w, installs: counts.get(w) }));
}

fastify.get('/v1/stats/history', async (req) => {
  // Clamp the requested window so a hostile or fat-fingered client
  // can't ask for thousands of weeks (104 = ~2 years of data is the
  // sensible upper bound for a public chart endpoint).
  const raw = Number((req.query && req.query.weeks) ?? 13);
  const weeks = Math.max(1, Math.min(104, Number.isFinite(raw) ? Math.floor(raw) : 13));
  const series = await weeklyHistory(weeks);
  return { weeks, series };
});

fastify.get('/v1/stats/cumulative', async (req) => {
  const raw = Number((req.query && req.query.weeks) ?? 52);
  const weeks = Math.max(1, Math.min(104, Number.isFinite(raw) ? Math.floor(raw) : 52));
  const series = await weeklyHistory(weeks);
  // Privacy-honest "cumulative": sum of weekly actives. The receiver
  // can't compute "unique installs ever" because salts rotate weekly
  // and hashes deliberately cannot be correlated across weeks. So this
  // is total ping-events counted, an over-estimate of unique installs
  // (an install that pings every week for a year contributes 52).
  let running = 0;
  const withCumulative = series.map((p) => {
    running += p.installs;
    return { ...p, cumulative: running };
  });
  return {
    weeks,
    firstWeek: series[0]?.week ?? null,
    currentWeek: series[series.length - 1]?.week ?? null,
    totalPingEvents: running,
    series: withCumulative,
    note:
      'cumulative = sum of weekly-active counts. salts rotate weekly so the ' +
      'receiver cannot compute unique-installs-ever; this is total ping-events ' +
      'counted, an over-estimate.',
  };
});

/**
 * SVG-rendered chart page. No client-side JS, no third-party CDN, just
 * server-side SVG embedded in HTML. Fits the receiver's no-tracker
 * ethos and lets curl + text browsers see a sensible representation.
 *
 * Top panel: bar chart of weekly active installs (last 26 weeks).
 * Bottom panel: cumulative line chart over the same window.
 */
fastify.get('/stats', async (req, reply) => {
  const raw = Number((req.query && req.query.weeks) ?? 26);
  const weeks = Math.max(4, Math.min(104, Number.isFinite(raw) ? Math.floor(raw) : 26));
  const series = await weeklyHistory(weeks);

  let running = 0;
  const withCumulative = series.map((p) => {
    running += p.installs;
    return { ...p, cumulative: running };
  });
  const current = withCumulative[withCumulative.length - 1];
  const peakWeekly = withCumulative.reduce((m, p) => Math.max(m, p.installs), 0);
  const peakCum = withCumulative[withCumulative.length - 1]?.cumulative ?? 0;

  reply.type('text/html');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>telemetry.danimoya.com · stats</title>
<style>
  body{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0b0d10;color:#e6edf3;
       margin:0;padding:2.5rem 1.5rem;line-height:1.55}
  main{max-width:880px;margin:0 auto}
  h1{font-size:1.5rem;margin:0 0 .25rem;letter-spacing:-.02em}
  h2{font-size:.95rem;color:#79c0ff;margin:2.25rem 0 .5rem;text-transform:uppercase;
     letter-spacing:.05em}
  p,li{font-size:.92rem}
  code{color:#79c0ff}
  a{color:#79c0ff}
  .nums{display:flex;gap:1.5rem;flex-wrap:wrap;margin:.75rem 0 0}
  .num{padding:.85rem 1.1rem;background:#161b22;border:1px solid #30363d;border-radius:6px;
       min-width:9rem}
  .num .label{color:#8b949e;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}
  .num .value{font-size:1.55rem;color:#79c0ff;margin-top:.15rem}
  .chart{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:.75rem;
         margin:.75rem 0;overflow-x:auto}
  /* Selectors target <text class="tick"> and <text class="axis"> directly —
     the earlier ".tick text" form matched a descendant, not the element
     itself, so labels rendered with the default (black) fill and were
     invisible on the near-black chart background. */
  .axis,text.tick,text.axis{fill:#c9d1d9;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace}
  .grid{stroke:#30363d;stroke-width:1}
  .bar{fill:#79c0ff}
  .line{fill:none;stroke:#3fb950;stroke-width:1.75}
  .footer{color:#8b949e;font-size:.78rem;margin-top:2.5rem;border-top:1px solid #30363d;
          padding-top:1rem}
  .note{color:#8b949e;font-size:.8rem;margin-top:.25rem}
</style></head>
<body><main>
<h1>telemetry stats</h1>
<p>Anonymous install pings reported to <code>telemetry.danimoya.com</code>,
last ${weeks} ISO weeks ending <code>${current?.week ?? '—'}</code>.
<a href="/">about</a> · <a href="/v1/stats">/v1/stats</a> ·
<a href="/v1/stats/history?weeks=${weeks}">/v1/stats/history</a> ·
<a href="/v1/stats/cumulative?weeks=${weeks}">/v1/stats/cumulative</a></p>

<div class="nums">
  <div class="num"><div class="label">This week</div>
    <div class="value">${current?.installs ?? 0}</div></div>
  <div class="num"><div class="label">Peak weekly</div>
    <div class="value">${peakWeekly}</div></div>
  <div class="num"><div class="label">Cumulative ping-events</div>
    <div class="value">${peakCum}</div></div>
  <div class="num"><div class="label">Window</div>
    <div class="value" style="font-size:1.05rem">${withCumulative[0]?.week ?? '—'} → ${current?.week ?? '—'}</div></div>
</div>

<h2>Weekly active installs</h2>
<div class="chart">${renderBarChart(withCumulative)}</div>

<h2>Cumulative ping-events</h2>
<div class="chart">${renderLineChart(withCumulative)}</div>
<p class="note">"Cumulative" is the running sum of the weekly-active counts above —
the only honest number the receiver can produce. Salts rotate weekly by design
so hashes from week <em>N</em> cannot be matched to week <em>N+1</em>; a true
"unique installs ever" figure is therefore <strong>not computable</strong> from
this data. An install that opts in and pings every week for a year contributes
52 to this number.</p>

<h2>Other windows</h2>
<p>
<a href="/stats?weeks=13">13 weeks</a> ·
<a href="/stats?weeks=26">26 weeks</a> ·
<a href="/stats?weeks=52">52 weeks</a> ·
<a href="/stats?weeks=104">104 weeks</a>
</p>

<p class="footer">No client-side JavaScript on this page. The SVG charts are
rendered server-side from <code>/v1/stats/history</code> and
<code>/v1/stats/cumulative</code>. The same numbers are accessible as JSON
for anyone wanting to plot them locally.</p>
</main></body></html>`;
});

// ── Server-side SVG renderers ──────────────────────────────────────
//
// Pure functions of the data — no DOM, no JS, no charting library.
// The receiver's whole posture is "no client trackers and no
// third-party CDN imports", and a small handful of <svg> elements
// stays inside that posture. Designed for readability over polish:
// gridlines, week labels, no axes-as-art.

function svgEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function chartGeometry(points) {
  // Shared coordinate system for bars + line: 800x220 with margins.
  const W = 800;
  const H = 220;
  const M = { top: 14, right: 16, bottom: 32, left: 36 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  return { W, H, M, innerW, innerH, n: points.length };
}

function yTicks(maxValue) {
  // Choose 4-5 round-number ticks above max, with a floor of 1 so an
  // all-zero chart still shows a baseline at 0/1.
  const ceil = Math.max(1, maxValue);
  // Round up to a "nice" number: 1,2,5,10,20,50,100,…
  const niceSteps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const step = niceSteps.find((s) => s * 4 >= ceil) || 10000;
  const top = step * 4;
  return { top, ticks: [0, step, step * 2, step * 3, top] };
}

function renderBarChart(points) {
  const g = chartGeometry(points);
  const max = points.reduce((m, p) => Math.max(m, p.installs), 0);
  const { top: yMax, ticks } = yTicks(max);
  const barW = g.innerW / Math.max(g.n, 1);
  const xOf = (i) => g.M.left + i * barW + barW * 0.15;
  const yOf = (v) => g.M.top + (1 - v / yMax) * g.innerH;

  const grid = ticks
    .map((t) => {
      const y = yOf(t).toFixed(1);
      return `<line class="grid" x1="${g.M.left}" x2="${g.M.left + g.innerW}" y1="${y}" y2="${y}"/>` +
        `<text class="tick" x="${g.M.left - 4}" y="${y}" text-anchor="end" dy="3">${t}</text>`;
    })
    .join('');

  const bars = points
    .map((p, i) => {
      const x = xOf(i);
      const y = yOf(p.installs);
      const h = g.M.top + g.innerH - y;
      const w = barW * 0.7;
      return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" ` +
        `width="${w.toFixed(1)}" height="${Math.max(h, 0).toFixed(1)}"><title>` +
        `${svgEscape(p.week)}: ${p.installs}</title></rect>`;
    })
    .join('');

  // Label every Nth week so the x-axis stays legible on long windows.
  const labelStride = Math.max(1, Math.ceil(g.n / 13));
  const labels = points
    .map((p, i) => {
      if (i % labelStride !== 0 && i !== g.n - 1) return '';
      const x = (xOf(i) + barW * 0.35).toFixed(1);
      const y = (g.M.top + g.innerH + 14).toFixed(1);
      return `<text class="tick" x="${x}" y="${y}" text-anchor="middle">${svgEscape(p.week)}</text>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${g.W} ${g.H}" width="100%" preserveAspectRatio="xMinYMid meet" ` +
    `role="img" aria-label="Weekly active installs">${grid}${bars}${labels}</svg>`;
}

function renderLineChart(points) {
  const g = chartGeometry(points);
  const max = points.reduce((m, p) => Math.max(m, p.cumulative), 0);
  const { top: yMax, ticks } = yTicks(max);
  const xStep = g.innerW / Math.max(g.n - 1, 1);
  const xOf = (i) => g.M.left + i * xStep;
  const yOf = (v) => g.M.top + (1 - v / yMax) * g.innerH;

  const grid = ticks
    .map((t) => {
      const y = yOf(t).toFixed(1);
      return `<line class="grid" x1="${g.M.left}" x2="${g.M.left + g.innerW}" y1="${y}" y2="${y}"/>` +
        `<text class="tick" x="${g.M.left - 4}" y="${y}" text-anchor="end" dy="3">${t}</text>`;
    })
    .join('');

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p.cumulative).toFixed(1)}`)
    .join(' ');

  const labelStride = Math.max(1, Math.ceil(g.n / 13));
  const labels = points
    .map((p, i) => {
      if (i % labelStride !== 0 && i !== g.n - 1) return '';
      const x = xOf(i).toFixed(1);
      const y = (g.M.top + g.innerH + 14).toFixed(1);
      return `<text class="tick" x="${x}" y="${y}" text-anchor="middle">${svgEscape(p.week)}</text>`;
    })
    .join('');

  const dots = points
    .map((p, i) => {
      const x = xOf(i).toFixed(1);
      const y = yOf(p.cumulative).toFixed(1);
      return `<circle cx="${x}" cy="${y}" r="2.5" fill="#3fb950"><title>` +
        `${svgEscape(p.week)}: ${p.cumulative} cumulative</title></circle>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${g.W} ${g.H}" width="100%" preserveAspectRatio="xMinYMid meet" ` +
    `role="img" aria-label="Cumulative ping-events">${grid}` +
    `<path class="line" d="${path}"/>${dots}${labels}</svg>`;
}

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

<h2>Public stats</h2>
<p>Open <a href="/stats"><code>/stats</code></a> for a per-week chart of
reported installs and cumulative ping-events. JSON for the same numbers
is available at <a href="/v1/stats/history?weeks=26"><code>/v1/stats/history</code></a>
and <a href="/v1/stats/cumulative?weeks=52"><code>/v1/stats/cumulative</code></a>.</p>

<h2>Endpoints</h2>
<ul>
  <li><code>POST /v1/ping</code> — submit a ping (called by the dashboards)</li>
  <li><code>GET  /v1/stats</code> — current week aggregate, public</li>
  <li><code>GET  /v1/stats/history?weeks=N</code> — last N weeks of installs (N ≤ 104), public</li>
  <li><code>GET  /v1/stats/cumulative?weeks=N</code> — same series with a running sum, public</li>
  <li><code>GET  /stats</code> — SVG-rendered chart of the above</li>
</ul>

<h2>Source</h2>
<p>Receiver source, schema, weekly salt rotation, and append-only audit
changelog: <a href="https://github.com/danimoya/telemetry">github.com/danimoya/telemetry</a>.</p>

<h2>Per-install transparency</h2>
<p>Each running dashboard exposes its own <code>/telemetry</code> page
showing exactly what that install would send. Read that page on your own
deployment before deciding whether to opt in.</p>

<p class="footer">Operated by Daniel Moya. Apache-2.0. Last
salt rotation: ${isoWeekBucket()}.</p>
</main></body></html>`;
});

export async function startServer({
  ensureSchemaFn = ensureSchema,
  loadSaltFn = loadSalt,
  listenFn = () => fastify.listen({ host: '0.0.0.0', port: PORT }),
} = {}) {
  await ensureSchemaFn();
  await loadSaltFn();
  return await listenFn();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    await startServer();
  } catch (err) {
    fastify.log.error({ err }, 'startup failed');
    process.exit(1);
  }
}
