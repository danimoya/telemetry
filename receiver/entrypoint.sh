#!/bin/sh
# Exports the telemetry-heliosdb password from the compose secret (/etc/heliosdb-telemetry/db.env on
# the host, root-owned 0600) as PGPASSWORD — node-postgres uses it because PG_URL carries no
# password — and drops to the unprivileged `node` user. The encryption key in the same file is never
# exported. finalise-week.sh runs its SQL through this entrypoint too (docker exec … receiver-entrypoint).
set -eu
SECRET="${DB_SECRET_FILE:-/run/secrets/db.env}"
if [ -z "${PGPASSWORD:-}" ] && [ -r "$SECRET" ]; then
  PGPASSWORD=$(sed -n 's/^DB_PASSWORD=//p' "$SECRET" | head -1)
  export PGPASSWORD
fi
if [ "$(id -u)" = 0 ]; then
  # /run/telemetry holds the salt file; the receiver must be able to write it.
  chown node:node /run/telemetry 2>/dev/null || true
  exec setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all env HOME=/home/node "$@"
fi
exec "$@"
