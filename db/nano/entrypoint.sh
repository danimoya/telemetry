#!/bin/sh
# Reads DB_PASSWORD and DB_ENCRYPTION_KEY from the compose secret (root-owned, 0600 on the host),
# creates a self-signed TLS certificate on first start (private key in /tls, certificate copied to
# /tls-pub, which clients mount read-only to verify the server), then runs HeliosDB-Nano as uid 999.
set -eu
SECRET="${DB_SECRET_FILE:-/run/secrets/db.env}"
[ -r "$SECRET" ] || { echo "[nano] cannot read $SECRET" >&2; exit 1; }
DB_PASSWORD=$(sed -n 's/^DB_PASSWORD=//p' "$SECRET" | head -1)
DB_ENCRYPTION_KEY=$(sed -n 's/^DB_ENCRYPTION_KEY=//p' "$SECRET" | head -1)
[ -n "$DB_PASSWORD" ] || { echo "[nano] DB_PASSWORD missing in $SECRET" >&2; exit 1; }
case "$DB_ENCRYPTION_KEY" in
  *[!0-9a-fA-F]*|"") echo "[nano] DB_ENCRYPTION_KEY must be 64 hex characters" >&2; exit 1 ;;
esac
[ ${#DB_ENCRYPTION_KEY} -eq 64 ] || { echo "[nano] DB_ENCRYPTION_KEY must be 64 hex characters" >&2; exit 1; }

TLS_CN="${TLS_CN:?TLS_CN (the service hostname clients connect to) is required}"

# A store is only ever opened by the engine line that created it: Nano 4.30+ replays the whole
# logical WAL of a 3.x store on open (HeliosDB-Nano #35), and at-rest encryption cannot be added to
# an existing store. A fresh /data is stamped; an unstamped non-empty /data is refused.
MARKER=/data/.heliosdb-store
if [ -e /data/CURRENT ] && [ ! -s "$MARKER" ]; then
  echo "[nano] /data holds a store this image did not create (no $MARKER) — refusing to open it." >&2
  echo "[nano] A pre-4.x store must be migrated into a NEW volume (docs/NANO-4.41-MIGRATION.md)." >&2
  exit 1
fi
if [ ! -e /data/CURRENT ]; then
  printf 'created-by=heliosdb-nano %s\ncreated-at=%s\nencryption=aes-256-gcm\n' "$NANO_VERSION" "$(date -u +%FT%TZ)" > "$MARKER"
fi
chown heliosdb:heliosdb /data /tls /tls-pub "$MARKER"
chmod 0700 /tls
if [ ! -s /tls/server.key ] || [ ! -s /tls/server.crt ]; then
  echo "[nano] generating self-signed TLS certificate for $TLS_CN"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout /tls/server.key -out /tls/server.crt -days 3650 -subj "/CN=$TLS_CN" \
    -addext "subjectAltName=DNS:$TLS_CN,DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
fi
chown heliosdb:heliosdb /tls/server.key /tls/server.crt
chmod 0600 /tls/server.key
chmod 0644 /tls/server.crt
cmp -s /tls/server.crt /tls-pub/server.crt || install -m 0644 -o heliosdb -g heliosdb /tls/server.crt /tls-pub/server.crt

# Rewritten as root on every start (no secrets in it: the key comes from the environment).
CONFIG=/etc/heliosdb/nano.toml
mkdir -p /etc/heliosdb
cat > "$CONFIG" <<TOML
[storage]
# fsync at COMMIT: a power loss cannot drop an acknowledged ping.
durable_commit = true

[encryption]
enabled = true
algorithm = "Aes256Gcm"

[encryption.key_source]
Environment = "HELIOSDB_ENCRYPTION_KEY"
TOML
chmod 0644 "$CONFIG"

# 4.41 accepts the password only as --password (no env/file option, HeliosDB-Nano #38), so it is
# in the engine's argv and readable by every host user through /proc/<pid>/cmdline. nano-mask-argv
# waits until the engine listens, then overwrites the value with '*' in the engine's argv memory.
# It runs as the engine's uid, and its pid is this shell's pid, which `exec` turns into the engine.
# The subshell exits at once, so the helper is re-parented to the container's init (compose
# `init: true`), which reaps it. A failure is logged; the engine keeps running.
( setpriv --reuid=999 --regid=999 --clear-groups --inh-caps=-all \
    perl /usr/local/bin/nano-mask-argv "$$" 5432 </dev/null & )

exec setpriv --reuid=999 --regid=999 --clear-groups --inh-caps=-all \
  env -u DB_PASSWORD -u DB_ENCRYPTION_KEY HELIOSDB_ENCRYPTION_KEY="$DB_ENCRYPTION_KEY" HOME=/home/heliosdb \
  heliosdb-nano start -c "$CONFIG" \
  --data-dir /data --listen 0.0.0.0 --port 5432 \
  --auth scram-sha-256 --password "$DB_PASSWORD" \
  --tls-cert /tls/server.crt --tls-key /tls/server.key --tls-post-quantum \
  --http-port 0 --authentication-timeout "${DB_AUTH_TIMEOUT:-30s}" \
  --max-connections "${DB_MAX_CONNECTIONS:-50}" "$@"
