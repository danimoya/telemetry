#!/usr/bin/env bash
# Rotates the telemetry-heliosdb SCRAM password and (re)writes the receiver's password-only secret.
#
#   sudo ops/rotate-db-password.sh            # new password, both files rewritten, nothing restarted
#   sudo ops/rotate-db-password.sh --client   # only (re)derive receiver.env from db.env
#
# Files (root:root 0600, directory /etc/heliosdb-telemetry):
#   db.env        DB_PASSWORD + DB_ENCRYPTION_KEY  -> compose secret telemetry_db (engine only)
#   receiver.env  DB_PASSWORD                      -> compose secret telemetry_db_client (receiver)
# DB_ENCRYPTION_KEY is never changed here (changing it would lock the store).
#
# The engine reads the password at start (Nano 4.41 keeps it in memory, not in the store), so the
# new password takes effect when both containers are recreated afterwards:
#   docker compose -p telemetry up -d --force-recreate --no-build heliosdb receiver
#   docker exec nginx-proxy-manager nginx -s reload
# Then copy db.env to the SAN and record the rotation in the private runbook.
# Values are never printed.
set -euo pipefail
umask 077
DIR=${TELEMETRY_SECRET_DIR:-/etc/heliosdb-telemetry}   # override only for rehearsals
DB_ENV=$DIR/db.env
CLIENT_ENV=$DIR/receiver.env

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
[ -r "$DB_ENV" ] || { echo "$DB_ENV missing" >&2; exit 1; }

key=$(sed -n 's/^DB_ENCRYPTION_KEY=//p' "$DB_ENV" | head -1)
[[ "$key" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "DB_ENCRYPTION_KEY in $DB_ENV is not 64 hex characters" >&2; exit 1; }

write_atomic() { # <target> ; content on stdin
  local tmp
  tmp=$(mktemp "$1.XXXXXX")
  cat > "$tmp"
  chown root:root "$tmp"; chmod 0600 "$tmp"
  sync -f "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$1"
}

case "${1:-}" in
  --client)
    password=$(sed -n 's/^DB_PASSWORD=//p' "$DB_ENV" | head -1)
    [ -n "$password" ] || { echo "DB_PASSWORD missing in $DB_ENV" >&2; exit 1; }
    ;;
  "")
    password=$(openssl rand -hex 24)   # 48 hex characters, CSPRNG
    # Rewrite db.env keeping every line except DB_PASSWORD.
    { printf 'DB_PASSWORD=%s\n' "$password"; grep -v '^DB_PASSWORD=' "$DB_ENV"; } | write_atomic "$DB_ENV"
    ;;
  *) echo "usage: $0 [--client]" >&2; exit 2 ;;
esac

printf 'DB_PASSWORD=%s\n' "$password" | write_atomic "$CLIENT_ENV"

# Self-check without printing values.
[ "$(sed -n 's/^DB_PASSWORD=//p' "$DB_ENV")" = "$(sed -n 's/^DB_PASSWORD=//p' "$CLIENT_ENV")" ] || { echo "password mismatch" >&2; exit 1; }
[ "$(sed -n 's/^DB_ENCRYPTION_KEY=//p' "$DB_ENV")" = "$key" ] || { echo "encryption key changed" >&2; exit 1; }
! grep -q '^DB_ENCRYPTION_KEY=' "$CLIENT_ENV" || { echo "key leaked into $CLIENT_ENV" >&2; exit 1; }
stat -c '%n %U:%G %a %s bytes' "$DB_ENV" "$CLIENT_ENV"
echo "db.env sha256 $(sha256sum "$DB_ENV" | cut -c1-16)…"
