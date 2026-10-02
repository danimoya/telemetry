#!/usr/bin/env bash
# Backs up telemetry-heliosdb (HeliosDB-Nano 4.41, encrypted at rest) locally and to the SAN,
# and proves every backup with a restore drill.
#
#   ops/telemetry-db-backup.sh               daily run (cron 01:57, app crontab)
#   ops/telemetry-db-backup.sh --san-drill   daily run + restore drill of the newest SAN copy today
#   ops/telemetry-db-backup.sh --local-only  local backup + drill, no SAN upload
#   ops/telemetry-db-backup.sh --check       monitor (cron hourly): alert when the last success is
#                                            >36 h old, or the last SAN drill failed / is >8 days old
#   ops/telemetry-db-backup.sh --list        what is on the SAN
#   ops/telemetry-db-backup.sh --drill FILE  restore drill of one archive (local file)
#
# What a run does:
#  1. Raw copy of the encrypted data directory, taken while the engine is frozen (`docker pause`,
#     well under a second for this store; durable_commit=true, so every acknowledged commit is on
#     disk): HeliosDB-Nano 4.41 cannot dump an encrypted directory (HeliosDB-Nano #45).
#     -> ~/backups/heliosdb-telemetry/telemetry-db-<UTC>.tar.gz (+ .sha256), kept 14 days.
#  2. Drill (every run): the archive is restored into scratch volumes and opened, on an isolated
#     --internal network, by a scratch engine with the production key; every table must read back
#     with the row counts the live store had around the freeze. A failed drill fails the run.
#  3. Upload over ssh (SFTP/scp are disabled on the SAN) to
#       $SAN_HOST:~/backups/heliosdb/telemetry/daily/telemetry-db-<UTC>.tar.gz (+ .sha256)
#     as a dot-partial file, checked with a REMOTE sha256sum, then renamed. Dirs 700, files 600.
#  4. Grandfather-father-son (server-side copies, verified): first backup of each ISO week ->
#     weekly/, first of each month -> monthly/. Retention: daily 7 days, weekly 4 weeks, monthly 3
#     months. Pruning deletes ONLY names matching the archive pattern inside those three
#     directories, never the newest archive of a tier, never after a failed upload.
#  5. On Sundays (or when the last SAN drill is >7 days old, or with --san-drill): download the
#     newest SAN daily, verify its sha256 and drill it like step 2.
#
# Logic follows the operator's other HeliosDB backup scripts. The archives stay encrypted; the key is NOT stored with them: it is in
# /etc/heliosdb-telemetry/db.env (root 0600) and, separately, in a separate secrets directory on the SAN.
# Runs as `app`; docker bind-mounts the root-only secret, so no sudo is needed.
# Failure: nonzero exit, a "TELEMETRY DB BACKUP FAILED" log line, an email (SMTP settings from the
# Cloud v2 .env, recipient ADMIN_EMAIL/CONTACT_TO), state in $STATE that --check alerts on.
set -Eeuo pipefail

SAN_HOST="${TELEMETRY_SAN_HOST:-backup-host}"
SAN_ROOT="${TELEMETRY_SAN_ROOT:-backups/heliosdb/telemetry}"   # relative to the SAN user's home
OUT="${TELEMETRY_BACKUP_ROOT:-$HOME/backups/heliosdb-telemetry}"
STATE="${TELEMETRY_BACKUP_STATE:-$HOME/.local/state/telemetry-db-backup}"
ENV_FILE="${TELEMETRY_ALERT_ENV:-/path/to/alert-smtp.env}"
SECRET=/etc/heliosdb-telemetry/db.env
DB=telemetry-heliosdb; APP=telemetry-receiver
SUBNET=10.250.21.0/24   # pinned: Docker's default address pools are exhausted on this host
KEEP_LOCAL_DAYS=14; KEEP_DAILY_DAYS=7; KEEP_WEEKLY_DAYS=28; KEEP_MONTHLY_MONTHS=3
NAME_RE='^telemetry-db-[0-9]{8}T[0-9]{6}Z\.tar\.gz(\.sha256)?$'
ARCHIVE_RE='^telemetry-db-[0-9]{8}T[0-9]{6}Z\.tar\.gz$'
PARTIAL_RE='^\.telemetry-db-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.partial$'
TABLES="pings pings_weekly"

MODE=daily; SAN_DRILL=false; DRILL_FILE=""
case "${1:-}" in
  "") ;;
  --san-drill) SAN_DRILL=true ;;
  --local-only) MODE=local ;;
  --check) MODE=check ;;
  --list) MODE=list ;;
  --drill) MODE=drill; DRILL_FILE="${2:?--drill needs an archive path}" ;;
  -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

umask 077
mkdir -p "$STATE" "$OUT"
CLEAN_DIRS=()
DRILL_TAG=""
cleanup() {
  if [ -n "$DRILL_TAG" ]; then
    docker rm -f "$DRILL_TAG" >/dev/null 2>&1 || true
    docker network rm "$DRILL_TAG" >/dev/null 2>&1 || true
    docker volume rm "$DRILL_TAG-data" "$DRILL_TAG-tls" "$DRILL_TAG-tlspub" >/dev/null 2>&1 || true
  fi
  docker unpause "$DB" >/dev/null 2>&1 || true
  [ ${#CLEAN_DIRS[@]} -eq 0 ] || rm -rf "${CLEAN_DIRS[@]}"
}
trap cleanup EXIT
log() { echo "$(date -u +%FT%TZ) [telemetry-db-backup] $*"; }

alert() {  # alert <subject> <body>: never fails the caller
  local subject="$1" body="$2"
  if ! ALERT_SUBJECT="$subject" ALERT_BODY="$body" ENV_FILE="$ENV_FILE" python3 - <<'PY'
import email.message, os, pathlib, smtplib, ssl, sys
def load(path):
    cfg = {}
    try:
        for line in pathlib.Path(path).read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                cfg[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return cfg
cfg = load(os.environ['ENV_FILE'])
to = (os.environ.get('TELEMETRY_ALERT_TO') or cfg.get('ADMIN_EMAIL') or cfg.get('CONTACT_TO')
      or load('/path/to/contact.env').get('CONTACT_TO'))
if not (to and cfg.get('SMTP_HOST') and cfg.get('SMTP_FROM')):
    print('alert: no recipient or SMTP settings', file=sys.stderr); sys.exit(1)
m = email.message.EmailMessage()
m['From'] = cfg['SMTP_FROM']; m['To'] = to; m['Subject'] = os.environ['ALERT_SUBJECT']
m.set_content(os.environ['ALERT_BODY'] + '\n\nRunbook: the private operations runbook; '
              'script: ~/telemetry/ops/telemetry-db-backup.sh; log: ~/.local/state/telemetry-db-backup/backup.log\n')
ctx = ssl.create_default_context()
if cfg.get('SMTP_ACCEPT_INVALID_CERTS', 'false') == 'true':
    ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
port = int(cfg.get('SMTP_PORT', '587'))
c = smtplib.SMTP_SSL(cfg['SMTP_HOST'], port, timeout=20, context=ctx) if port == 465 else smtplib.SMTP(cfg['SMTP_HOST'], port, timeout=20)
with c:
    if port != 465: c.starttls(context=ctx)
    if cfg.get('SMTP_USER'): c.login(cfg['SMTP_USER'], cfg.get('SMTP_PASS', ''))
    c.send_message(m)
print('alert sent to ' + to)
PY
  then
    log "ALERT EMAIL FAILED (subject: $subject)"
  fi
}

json_state() {  # json_state <file> key=value ...
  python3 - "$@" <<'PY'
import json, os, sys, time
out = {'at': int(time.time())}
for kv in sys.argv[2:]:
    k, v = kv.split('=', 1)
    if v in ('true', 'false'): v = (v == 'true')
    else:
        try: v = int(v)
        except ValueError: pass
    out[k] = v
open(sys.argv[1] + '.tmp', 'w').write(json.dumps(out, indent=1) + '\n')
os.replace(sys.argv[1] + '.tmp', sys.argv[1])
PY
}

STEP=start
on_error() {
  local rc=$?
  trap - ERR
  [ "$BASH_SUBSHELL" -eq 0 ] || exit "$rc"
  log "TELEMETRY DB BACKUP FAILED at step '$STEP' (exit $rc, line ${1:-?})"
  json_state "$STATE/last-failure.json" mode="$MODE" step="$STEP" exit="$rc" || true
  alert "Telemetry DB: backup FAILED ($STEP)" "The telemetry-heliosdb backup ($MODE run) failed at step: $STEP (exit $rc).
Nothing on the SAN was pruned by this run.

$(tail -n 40 "$STATE/backup.log" 2>/dev/null || true)"
  exit "$rc"
}
trap 'on_error $LINENO' ERR

san() { ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 "$SAN_HOST" "$@"; }
ts_epoch() { local t="$1"; date -u -d "${t:0:4}-${t:4:2}-${t:6:2} ${t:9:2}:${t:11:2}:${t:13:2}" +%s; }
name_ts() { local n="${1#telemetry-db-}"; echo "${n%%.tar.gz*}"; }
san_list() { san "cd ~/$SAN_ROOT/$1 && ls -1A" | grep -E "$ARCHIVE_RE" | sort || true; }

# counts <container-on-a-network-with-the-db> -> {"pings": n, "pings_weekly": n}
COUNT_JS='const pg=require("pg");const c=new pg.Client({connectionString:process.env.PG_URL});
(async()=>{await c.connect();const o={};for(const t of process.argv.slice(1)){o[t]=Number((await c.query("SELECT count(*) AS n FROM "+t)).rows[0].n)}
console.log(JSON.stringify(o));await c.end()})().catch(e=>{console.error(e.message);process.exit(1)})'
live_counts() { docker exec "$APP" receiver-entrypoint node -e "$COUNT_JS" $TABLES; }

# ---------------------------------------------------------------- check
if [ "$MODE" = check ]; then
  issues=(); now=$(date +%s)
  succ=$(python3 -c "import json;print(json.load(open('$STATE/last-success.json'))['at'])" 2>/dev/null || echo 0)
  [ $((now - succ)) -le $((36 * 3600)) ] || issues+=("no successful backup + SAN upload in the last 36 hours")
  drill=$(python3 -c "import json;d=json.load(open('$STATE/last-san-drill.json'));print(d['at'],str(d.get('ok')).lower())" 2>/dev/null || echo "0 false")
  [ "${drill#* }" = true ] || issues+=("the last SAN restore drill did not pass")
  [ $((now - ${drill%% *})) -le $((8 * 86400)) ] || issues+=("no SAN restore drill in the last 8 days")
  if [ ${#issues[@]} -eq 0 ]; then log "check: healthy"; exit 0; fi
  msg=$(printf '%s; ' "${issues[@]}"); log "check: $msg"
  last=$(cat "$STATE/check-last-alert" 2>/dev/null || echo 0)
  if [ $((now - last)) -gt $((6 * 3600)) ]; then
    alert "Telemetry DB: backup needs attention" "Checks needing attention: $msg"; echo "$now" > "$STATE/check-last-alert"
  fi
  exit 1
fi

if [ "$MODE" = list ]; then
  for tier in daily weekly monthly; do echo "== $tier"; san "cd ~/$SAN_ROOT/$tier 2>/dev/null && ls -l" | grep -E 'telemetry-db-' || true; done
  exit 0
fi

# ---------------------------------------------------------------- drill
# drill <archive> <expected-low-json> <expected-high-json>: restore + open with the key + counts
drill() {
  local archive="$1" lo="$2" hi="$3" image app_image restored ok
  image=$(docker inspect -f '{{.Config.Image}}' "$DB"); app_image=$(docker inspect -f '{{.Config.Image}}' "$APP")
  DRILL_TAG="telemetry-drill-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  docker network create --internal --subnet "$SUBNET" "$DRILL_TAG" >/dev/null
  gunzip -c "$archive" | docker run --rm -i --network none -v "$DRILL_TAG-data:/data" alpine \
    sh -c 'tar -C /data -xf - && chown -R 999:999 /data'
  docker run -d --name "$DRILL_TAG" --network "$DRILL_TAG" --network-alias telemetry-heliosdb -e TLS_CN=telemetry-heliosdb \
    -v "$SECRET:/run/secrets/db.env:ro" -v "$DRILL_TAG-data:/data" -v "$DRILL_TAG-tls:/tls" -v "$DRILL_TAG-tlspub:/tls-pub" "$image" >/dev/null
  for _ in $(seq 1 30); do docker logs "$DRILL_TAG" 2>&1 | grep -q "Server ready" && break; sleep 1; done
  restored=$(docker run --rm --network "$DRILL_TAG" -v "$SECRET:/run/secrets/db.env:ro" -v "$DRILL_TAG-tlspub:/tls-pub:ro" \
    -e 'PG_URL=postgresql://postgres@telemetry-heliosdb:5432/heliosdb?sslmode=verify-full&sslrootcert=/tls-pub/server.crt' \
    "$app_image" node -e "$COUNT_JS" $TABLES)
  ok=$(python3 -c "
import json, sys
lo, hi, r = (json.loads(x) for x in sys.argv[1:4])
print('ok' if set(r) == set(lo) and all(min(lo[t], hi[t]) <= r[t] <= max(lo[t], hi[t]) for t in r) else 'MISMATCH')
" "$lo" "$hi" "$restored")
  docker rm -f "$DRILL_TAG" >/dev/null; docker network rm "$DRILL_TAG" >/dev/null
  docker volume rm "$DRILL_TAG-data" "$DRILL_TAG-tls" "$DRILL_TAG-tlspub" >/dev/null; DRILL_TAG=""
  echo "drill=$ok restored=$restored expected=$lo..$hi"
  [ "$ok" = ok ]
}

if [ "$MODE" = drill ]; then
  STEP=drill; now=$(live_counts); drill "$DRILL_FILE" "$now" "$now"; exit 0
fi

# ---------------------------------------------------------------- 1. local raw backup
STEP=local-backup
STAMP=$(date -u +%Y%m%dT%H%M%SZ); NAME="telemetry-db-$STAMP.tar.gz"
VOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$DB")
[ -n "$VOL" ] || { log "cannot find the /data volume of $DB"; false; }
before=$(live_counts)
started=$(date +%s%N)
docker pause "$DB" >/dev/null
docker run --rm --network none -v "$VOL:/data:ro" alpine tar -C /data -cf - . | gzip -6 > "$OUT/.$NAME.partial"
docker unpause "$DB" >/dev/null
frozen_ms=$(( ($(date +%s%N) - started) / 1000000 ))
after=$(live_counts)
mv "$OUT/.$NAME.partial" "$OUT/$NAME"
(cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256")
SUM=$(cut -d' ' -f1 "$OUT/$NAME.sha256"); SIZE=$(stat -c %s "$OUT/$NAME")
log "local: $NAME ($SIZE bytes, sha256 $SUM) volume=$VOL frozen ${frozen_ms}ms live=$after"

STEP=local-drill
out=$(drill "$OUT/$NAME" "$before" "$after") || { echo "$out"; json_state "$STATE/last-local-drill.json" ok=false archive="$NAME"; false; }
log "local $out"
json_state "$STATE/last-local-drill.json" ok=true archive="$NAME" sha256="$SUM"
find "$OUT" -maxdepth 1 -name 'telemetry-db-*.tar.gz*' -mtime +"$KEEP_LOCAL_DAYS" -delete

if [ "$MODE" = local ]; then log "done (local only)"; exit 0; fi

# ---------------------------------------------------------------- 2. upload + verify
STEP=san-prepare
san "mkdir -p ~/$SAN_ROOT/daily ~/$SAN_ROOT/weekly ~/$SAN_ROOT/monthly && chmod 700 ~/$SAN_ROOT ~/$SAN_ROOT/daily ~/$SAN_ROOT/weekly ~/$SAN_ROOT/monthly"
STEP=upload
san "cd ~/$SAN_ROOT/daily && cat > .$NAME.partial && chmod 600 .$NAME.partial" < "$OUT/$NAME"
STEP=verify-upload
REMOTE=$(san "cd ~/$SAN_ROOT/daily && sha256sum .$NAME.partial" | awk '{print $1}')
[ "$REMOTE" = "$SUM" ] || { log "remote sha256 $REMOTE != local $SUM"; false; }
san "cd ~/$SAN_ROOT/daily && mv -f .$NAME.partial $NAME && printf '%s  %s\n' $SUM $NAME > $NAME.sha256 && chmod 600 $NAME $NAME.sha256 && sha256sum -c --quiet $NAME.sha256"
log "uploaded and verified: $SAN_HOST:~/$SAN_ROOT/daily/$NAME"

# ---------------------------------------------------------------- 3. promote
STEP=promote
promote() {
  local tier="$1"
  san "set -e; cd ~/$SAN_ROOT; cp daily/$NAME $tier/.$NAME.partial; chmod 600 $tier/.$NAME.partial
       s=\$(sha256sum $tier/.$NAME.partial | cut -d' ' -f1); [ \"\$s\" = $SUM ]
       mv -f $tier/.$NAME.partial $tier/$NAME; cp daily/$NAME.sha256 $tier/$NAME.sha256; chmod 600 $tier/$NAME $tier/$NAME.sha256"
  log "promoted to $tier/$NAME (server-side copy, sha256 verified)"
}
week_of() { date -u -d "${1:0:4}-${1:4:2}-${1:6:2}" +%G-W%V; }
have_week=false; for n in $(san_list weekly); do [ "$(week_of "$(name_ts "$n")")" = "$(week_of "$STAMP")" ] && have_week=true; done
$have_week || promote weekly
have_month=false; for n in $(san_list monthly); do t=$(name_ts "$n"); [ "${t:0:6}" = "${STAMP:0:6}" ] && have_month=true; done
$have_month || promote monthly

# ---------------------------------------------------------------- 4. prune
STEP=prune
today_day=$(( $(date -u +%s) / 86400 )); this_month=$(( 10#$(date -u +%Y) * 12 + 10#$(date -u +%m) ))
prune_tier() {
  local tier="$1" names newest n t age del=()
  names=$(san "cd ~/$SAN_ROOT/$tier && ls -1A")
  newest=$(echo "$names" | grep -E "$ARCHIVE_RE" | sort | tail -1 || true)
  for n in $(echo "$names" | grep -E "$ARCHIVE_RE" || true); do
    [ "$n" = "$newest" ] && continue
    t=$(name_ts "$n")
    case "$tier" in
      daily)   age=$(( today_day - $(ts_epoch "$t") / 86400 )); [ "$age" -ge "$KEEP_DAILY_DAYS" ] || continue ;;
      weekly)  age=$(( today_day - $(ts_epoch "$t") / 86400 )); [ "$age" -ge "$KEEP_WEEKLY_DAYS" ] || continue ;;
      monthly) age=$(( this_month - (10#${t:0:4} * 12 + 10#${t:4:2}) )); [ "$age" -ge "$KEEP_MONTHLY_MONTHS" ] || continue ;;
    esac
    del+=("$n"); echo "$names" | grep -qxF "$n.sha256" && del+=("$n.sha256")
  done
  for n in $(echo "$names" | grep -E '^telemetry-db-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.sha256$' || true); do
    echo "$names" | grep -qxF "${n%.sha256}" || del+=("$n")
  done
  for n in $(echo "$names" | grep -E "$PARTIAL_RE" || true); do [ "$n" = ".$NAME.partial" ] || del+=("$n"); done
  [ ${#del[@]} -gt 0 ] || { log "prune $tier: nothing to delete"; return 0; }
  for n in "${del[@]}"; do [[ "$n" =~ $NAME_RE || "$n" =~ $PARTIAL_RE ]] || { log "prune $tier: refusing '$n'"; return 1; }; done
  san "cd ~/$SAN_ROOT/$tier && rm -f -- ${del[*]}"
  log "prune $tier: deleted ${del[*]}"
}
for tier in daily weekly monthly; do prune_tier "$tier"; done

json_state "$STATE/last-success.json" ok=true name="$NAME" sha256="$SUM" size="$SIZE" frozen_ms="$frozen_ms"
rm -f "$STATE/last-failure.json"
log "backup OK: $NAME"

# ---------------------------------------------------------------- 5. SAN drill
last=$(python3 -c "import json;d=json.load(open('$STATE/last-san-drill.json'));print(d['at'] if d.get('ok') else 0)" 2>/dev/null || echo 0)
if $SAN_DRILL || [ "$(date -u +%u)" = 7 ] || [ $(( $(date +%s) - last )) -gt $((7 * 86400)) ]; then
  STEP=san-drill
  newest=$(san_list daily | tail -1)
  dtmp=$(mktemp -d "$OUT/.san-drill-XXXXXX"); CLEAN_DIRS+=("$dtmp")
  san "cat ~/$SAN_ROOT/daily/$newest" > "$dtmp/$newest"
  want=$(san "cat ~/$SAN_ROOT/daily/$newest.sha256" | awk '{print $1}'); got=$(sha256sum "$dtmp/$newest" | awk '{print $1}')
  [ -n "$want" ] && [ "$want" = "$got" ] || { log "SAN drill: sha256 mismatch for $newest"; json_state "$STATE/last-san-drill.json" ok=false archive="$newest"; false; }
  now=$(live_counts)
  out=$(drill "$dtmp/$newest" "$after" "$now") || { echo "$out"; json_state "$STATE/last-san-drill.json" ok=false archive="$newest"; false; }
  log "SAN $out ($newest)"
  json_state "$STATE/last-san-drill.json" ok=true archive="$newest" sha256="$got"
fi
log "done"
