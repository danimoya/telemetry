-- Telemetry receiver schema. Single table, no foreign keys, no PII columns.

CREATE TABLE IF NOT EXISTS pings (
  -- ISO-week bucket: e.g. '2026-18'. Combined with the rotating salt this
  -- means hashes only collide within the same week.
  week_bucket        TEXT NOT NULL,

  -- SHA-256(salt_<YYYY-W> || client_ip || installation_id) hex.
  hash               TEXT NOT NULL,

  -- Reported by the client. No interpretation, no further joins.
  dashboard_version  TEXT NOT NULL,
  heliosdb_version   TEXT,

  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (week_bucket, hash)
);

CREATE INDEX IF NOT EXISTS pings_week_idx ON pings (week_bucket);
CREATE INDEX IF NOT EXISTS pings_received_idx ON pings (received_at);

-- Retention: drop per-row rows older than 90 days. The aggregate counts are
-- materialised into `pings_weekly` (run by salt-rotate.cron) so we lose row
-- granularity but keep the trend forever.
CREATE TABLE IF NOT EXISTS pings_weekly (
  week_bucket        TEXT PRIMARY KEY,
  installs           INTEGER NOT NULL,
  finalised_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The "active installs this week" headline number:
--   SELECT COUNT(DISTINCT hash) FROM pings
--    WHERE week_bucket = to_char(now() AT TIME ZONE 'utc', 'IYYY-IW');
