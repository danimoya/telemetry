#!/usr/bin/env bash
# Materialise completed ISO weeks into the `pings_weekly` aggregate
# table. Without this, the per-row `pings` rows get pruned at 90 days
# and any history older than ~13 weeks silently disappears from
# /v1/stats/history and the /stats chart.
#
# Run by salt-rotate.cron immediately after the weekly salt rotation
# (Monday 00:05 UTC). Safe to run more often — INSERT … ON CONFLICT
# DO UPDATE keeps the row in sync with the latest count.
#
# Container model:
#   - The receiver and its HeliosDB-Nano live in a docker compose
#     stack named `telemetry`.
#   - This script `docker exec`s into the receiver container, which has
#     the right PG_URL env baked in (TLS verify-full, password from the
#     compose secret), and runs the SQL through node-pg there.
#   - Run from the host: bash /opt/telemetry/receiver/finalise-week.sh
#
# Idempotent.
set -euo pipefail

RECEIVER="${RECEIVER_CONTAINER:-telemetry-receiver}"
DB="${DB_CONTAINER:-telemetry-heliosdb}"
LOG="${FINALISE_LOG:-/var/log/telemetry-finalise.log}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(ts) $*" | tee -a "$LOG"; }

if ! docker ps --format '{{.Names}}' | grep -qx "$DB"; then
  log "FATAL: container $DB not running"
  exit 1
fi

current_week="$(date -u +%G-%V)"
log "current week is $current_week — finalising every other week present in pings"

# HeliosDB-Nano-friendly SQL (single statement, no parameter binding,
# no extended-query protocol — see claude-dashboard:docs/heliosdb-bugs.md
# for the matching bug list). The DDL has already been ensured by the
# receiver's bootstrap, so this script only writes data.
#
# Bug #10 (aggregate alias dropped): the inner aggregate result column
# is named `count`, not `installs`. We use the literal SELECT below
# and trust the outer INSERT to assign the value to `installs` by
# position, which Nano honours.
#
# Bug #11 (column projection ignored) was originally relevant here
# but the receiver workload only matters for the INSERT, not the
# SELECT shape — every column listed is used.
sql="$(cat <<EOF
INSERT INTO pings_weekly (week_bucket, installs)
SELECT week_bucket, COUNT(DISTINCT hash)
  FROM pings
 WHERE week_bucket <> '$current_week'
 GROUP BY week_bucket
ON CONFLICT (week_bucket) DO UPDATE SET
  installs     = EXCLUDED.installs,
  finalised_at = now()
EOF
)"

# psql isn't installed in the heliosdb container, but the receiver
# container has node-pg. Easier: pipe SQL through a tiny node REPL.
# This keeps the dependency surface to what the receiver already has.
# receiver-entrypoint exports PGPASSWORD from the compose secret (PG_URL carries no password since
# the 2026-10-02 move to Nano 4.41 + TLS) and drops to the `node` user.
docker exec -i "$RECEIVER" receiver-entrypoint node -e '
  const pg = require("pg");
  const url = process.env.PG_URL;
  if (!url) { console.error("PG_URL not set"); process.exit(2); }
  const pool = new pg.Pool({ connectionString: url });
  let buf = "";
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", async () => {
    try {
      const r = await pool.query(buf);
      console.log("finalise OK: " + (r.rowCount ?? 0) + " rows affected");
    } catch (e) {
      console.error("finalise FAILED: " + e.message);
      process.exit(1);
    } finally {
      await pool.end();
    }
  });
' <<<"$sql" 2>&1 | tee -a "$LOG"

log "done"
