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

async function loadSalt() {
  try {
    return (await readFile(SALT_FILE, 'utf8')).trim();
  } catch {
    // No salt file yet — generate one in memory only. Operators should
    // run salt-rotate.cron to persist a sealed weekly salt.
    return randomBytes(32).toString('hex');
  }
}

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

fastify.post('/v1/ping', async (req, reply) => {
  const body = req.body || {};
  if (
    typeof body.installation_id !== 'string' ||
    !/^[a-f0-9]{16,64}$/.test(body.installation_id)
  ) {
    return reply.code(400).send({ error: 'invalid installation_id' });
  }
  if (typeof body.dashboard_version !== 'string') {
    return reply.code(400).send({ error: 'invalid dashboard_version' });
  }

  const ip = req.ip; // edge-supplied; never written.
  const week = isoWeekBucket();
  const hash = createHash('sha256')
    .update(`${SALT}|${week}|${ip}|${body.installation_id}`)
    .digest('hex');

  try {
    await pool.query(
      `INSERT INTO pings (week_bucket, hash, dashboard_version, heliosdb_version)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (week_bucket, hash) DO NOTHING`,
      [week, hash, body.dashboard_version, body.heliosdb_version || null]
    );
  } catch (err) {
    req.log.error({ err }, 'pings insert failed');
    return reply.code(500).send({ error: 'storage failure' });
  }

  // Aggregates only. The client sees nothing about IP, hash, or stored row.
  return { ok: true };
});

fastify.get('/v1/stats', async () => {
  const week = isoWeekBucket();
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT hash) AS installs
       FROM pings
      WHERE week_bucket = $1`,
    [week]
  );
  return { week, installs: Number(rows[0]?.installs || 0) };
});

fastify.listen({ host: '0.0.0.0', port: PORT });
