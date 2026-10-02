#!/usr/bin/env bash
# Weekly job, two steps:
#   1. finalise: materialise completed ISO weeks into the `pings_weekly`
#      aggregate table (kept indefinitely).
#   2. prune: delete per-row `pings` rows of every ISO week that ended
#      more than 90 days ago, i.e. weeks before the ISO week that
#      contained "now - 90 days". A row is therefore deleted at the
#      first weekly run after it is 90 days old (at most ~97 days).
#      A week is pruned only if step 1 stored its aggregate and the
#      stored count equals the live count, so /v1/stats/history keeps
#      the trend after the rows are gone.
#
# Pruning keys on week_bucket, not received_at: one migrated row has a
# NULL received_at (see schema.sql), and the week is what the published
# policy and the aggregate are defined by.
#
# Schedule: Monday 00:05 UTC (see salt-rotate.cron). Safe to run more
# often: INSERT ... ON CONFLICT DO UPDATE keeps aggregates in sync and
# the prune is a no-op once old weeks are gone.
#
# Container model:
#   - The receiver and its HeliosDB-Nano live in a docker compose
#     stack named `telemetry`.
#   - This script `docker exec`s into the receiver container, which has
#     the right PG_URL env baked in (TLS verify-full, password from the
#     compose secret), and runs the SQL through node-pg there.
#   - Run from the host: bash <checkout>/receiver/finalise-week.sh
#
# Environment:
#   FINALISE_LOG     log file (default /var/log/telemetry-finalise.log)
#   RETENTION_DAYS   per-row retention (default 90)
#   PRUNE=0          finalise only, no prune
#   PRUNE_DRY_RUN=1  finalise, then report what would be pruned
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
RETENTION_DAYS="${RETENTION_DAYS:-90}"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$RETENTION_DAYS" -ge 90 ] || { log "FATAL: RETENTION_DAYS must be an integer >= 90"; exit 1; }
cutoff_week="$(date -u -d "$RETENTION_DAYS days ago" +%G-%V)"
WEEK_RE='^[0-9]{4}-[0-9]{2}$'
[[ "$current_week" =~ $WEEK_RE && "$cutoff_week" =~ $WEEK_RE ]] || { log "FATAL: bad week bucket"; exit 1; }
log "current week is $current_week — finalising every other week present in pings"

# HeliosDB-Nano notes (see claude-dashboard:docs/heliosdb-bugs.md):
#   - Bug #10: the aggregate alias is dropped, the COUNT column comes back as `count`.
#   - Nano 4.41: `INSERT ... SELECT ... GROUP BY ... ON CONFLICT DO UPDATE` raises a primary-key
#     violation once the week already exists, and `DELETE ... WHERE x IN (SELECT ...)` is not
#     supported. So counts are read once and every write is a single-row literal statement on a
#     regex-validated week bucket.
# psql isn't installed in the heliosdb container; the receiver container has node-pg.
# receiver-entrypoint exports PGPASSWORD from the compose secret (PG_URL carries no password since
# the 2026-10-02 move to Nano 4.41 + TLS) and drops to the `node` user.
docker exec \
  -e PRUNE="${PRUNE:-1}" -e PRUNE_DRY_RUN="${PRUNE_DRY_RUN:-0}" -e CUTOFF_WEEK="$cutoff_week" -e CURRENT_WEEK="$current_week" \
  "$RECEIVER" receiver-entrypoint node -e '
  const pg = require("pg");
  const url = process.env.PG_URL;
  if (!url) { console.error("PG_URL not set"); process.exit(2); }
  const WEEK = /^[0-9]{4}-[0-9]{2}$/;
  const cutoff = process.env.CUTOFF_WEEK;
  const prune = process.env.PRUNE !== "0";
  const dry = process.env.PRUNE_DRY_RUN === "1";
  const pool = new pg.Pool({ connectionString: url });
  const current = process.env.CURRENT_WEEK;
  (async () => {
    try {
      if (!WEEK.test(current)) throw new Error("bad current week");
      const q = (sql) => pool.query(sql);
      const lit = (w) => { if (!WEEK.test(w)) throw new Error("bad week " + JSON.stringify(w)); return "\x27" + w + "\x27"; };
      const done = (await q(
        "SELECT week_bucket, COUNT(DISTINCT hash) FROM pings WHERE week_bucket <> " + lit(current) + " GROUP BY week_bucket"
      )).rows;
      for (const row of done) {
        const n = Number(row.count ?? row.installs);
        if (!Number.isInteger(n) || n < 0) throw new Error("bad count for " + row.week_bucket);
        await q("INSERT INTO pings_weekly (week_bucket, installs) VALUES (" + lit(row.week_bucket) + ", " + n + ")" +
                " ON CONFLICT (week_bucket) DO UPDATE SET installs = EXCLUDED.installs, finalised_at = now()");
      }
      console.log("finalise OK: " + done.length + " completed weeks upserted");
      if (!prune) { console.log("prune skipped (PRUNE=0)"); return; }
      if (!WEEK.test(cutoff)) throw new Error("bad cutoff week");
      // Nano: no IN (subquery) in DELETE, aggregate alias dropped (column is `count`), so the
      // guard runs here and the delete is one literal statement per validated week.
      const live = (await pool.query(
        "SELECT week_bucket, COUNT(DISTINCT hash) FROM pings WHERE week_bucket < \x27" + cutoff + "\x27 GROUP BY week_bucket"
      )).rows;
      const agg = new Map((await pool.query(
        "SELECT week_bucket, installs FROM pings_weekly WHERE week_bucket < \x27" + cutoff + "\x27"
      )).rows.map((x) => [x.week_bucket, Number(x.installs)]));
      let deleted = 0, skipped = 0;
      for (const row of live) {
        const w = row.week_bucket, n = Number(row.count ?? row.installs);
        if (!WEEK.test(w) || w >= cutoff) { console.error("prune: refusing week " + JSON.stringify(w)); skipped++; continue; }
        if (agg.get(w) !== n) { console.error("prune: week " + w + " aggregate " + agg.get(w) + " != live " + n + ", kept"); skipped++; continue; }
        if (dry) { console.log("prune (dry run): would delete week " + w + " (" + n + " installs)"); continue; }
        const d = await pool.query("DELETE FROM pings WHERE week_bucket = \x27" + w + "\x27");
        deleted += d.rowCount ?? 0;
        console.log("prune: week " + w + " deleted " + (d.rowCount ?? 0) + " rows (aggregate " + n + " kept)");
      }
      console.log("prune " + (dry ? "dry run " : "") + "OK: cutoff " + cutoff + ", " + live.length + " old weeks, " + deleted + " rows deleted, " + skipped + " weeks kept");
      if (skipped) process.exitCode = 1;
    } catch (e) {
      console.error("finalise/prune FAILED: " + e.message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
' 2>&1 | tee -a "$LOG"

log "done"
