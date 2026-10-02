# Telemetry store on HeliosDB-Nano 4.41.0 — encrypted at rest, post-quantum TLS

Cut over 2026-10-02 (09:23:43–09:23:56 UTC, 12.5 s without a receiver). Secrets and the operator
procedures (keys, backup, restore, rotation, rollback) live in the private runbook
the private operations runbook, never here.

## What runs now

| | |
|---|---|
| Engine | official HeliosDB-Nano **v4.41.0** release binary on `debian:trixie-slim` (`db/nano/`, sha256-pinned; the binary needs glibc ≥ 2.39), image `telemetry-heliosdb:4.41.0` |
| At rest | `[encryption] enabled`, AES-256-GCM on every stored value (keys/table names stay visible on disk, as documented by Nano) |
| In transit | TLS 1.3 with `--tls-post-quantum`: the server picks **X25519MLKEM768** (hybrid ML-KEM-768 + X25519) when the client offers it |
| Auth | SCRAM-SHA-256, bootstrap role `postgres` (SQL-created roles cannot log in with SCRAM on 4.41, HeliosDB-Nano #49) |
| Durability | `storage.durable_commit = true` (fsync at COMMIT) |
| Network | `telemetry_db` (internal, 10.250.20.0/24); only the receiver joins it; no published port; HTTP/MCP listener off |
| Secret | `/etc/heliosdb-telemetry/db.env` (root, 0600): `DB_PASSWORD`, `DB_ENCRYPTION_KEY`, mounted as the compose secret `telemetry_db`. Both entrypoints start as root only to read it, then drop to uid 999 (DB) / 1000 `node` (receiver). The receiver gets only the password (`PGPASSWORD`); `PG_URL` carries none |
| Volumes | `telemetry_telemetry_heliosdb_441` (store), `telemetry_telemetry_heliosdb_tls` (key + cert, DB only), `telemetry_telemetry_heliosdb_tlspub` (cert only, read-only in the receiver) |
| Client | receiver on `node:24-trixie-slim` (Node 24.21, OpenSSL 3.5.8): `PG_URL=postgresql://postgres@telemetry-heliosdb:5432/heliosdb?sslmode=verify-full&sslrootcert=/tls-pub/server.crt` — node-postgres pins the self-signed certificate and checks the host name |

**Losing `DB_ENCRYPTION_KEY` loses the store.** Nano verifies a sealed sentinel on every open, so a
wrong key is refused (checked in the rehearsal); there is no key rotation in 4.41 — re-keying is a
copy into a fresh store (`db/migrate/copy_telemetry.py` works 4.x → 4.x as well).

The server does not refuse a plaintext client (`start` hard-codes `SslMode::Prefer`, HeliosDB-Nano
#53). The receiver uses `sslmode=verify-full`, and nothing else can reach the internal network.

## What was wrong before: the rows were in another product's database

The old receiver's `PG_URL` named the host `heliosdb`. The receiver sits on two networks, and on the
shared `management-network` another service's HeliosDB-Full container carries the
network alias `heliosdb` — Docker's resolver answered with that one, not with the
stack's own `telemetry-heliosdb`. Since 2026-05-03 every ping was written into the other service's
database (alongside its `blog_*` / `crm_*` tables), and the `telemetry-heliosdb` store
(`telemetry_telemetry_heliosdb`) held no table at all (its RocksDB had two writes ever; opening a
copy of it showed no `pings`). The receiver now names its database by container name on an internal
network, so the alias cannot capture it again.

## How the data moved

`db/migrate/copy_telemetry.py` (image: `db/migrate/Dockerfile`, psycopg over OpenSSL 3.5), with the
receiver stopped, from the other service's database (read-only `SELECT`s) into the fresh store:

- Only `pings` and `pings_weekly` are telemetry's; the other service's tables were not read or touched.
- Rehearsed first on a copy of that service's volume (files read `:ro`, opened by that service's own image on an
  isolated `--internal` network) into a scratch 4.41 store, then with the receiver on Node 24
  against it: ping insert, `/v1/stats`, `/v1/stats/history`, `finalise-week.sh`, a restart (rows
  persisted), a canary string absent from the data directory, a wrong key refused, and the
  ServerHello group (4588).
- The source engine did not enforce the primary key: `ON CONFLICT (week_bucket, hash) DO NOTHING`
  had stored 3 duplicate pairs (same week + hash, seconds apart). The new store enforces it, so the
  copy keeps what DO NOTHING means — the first row per key — and lists the dropped duplicates.
  Every published number is a `COUNT(DISTINCT hash)`, so none changes.
- One row (week 2026-40) has `received_at` NULL although the column says `NOT NULL DEFAULT now()`
  (the source did not apply the default). It is copied as it is, so the new `pings.received_at`
  has no `NOT NULL`; new rows get `now()` (checked).
- The source's `COUNT(*)` is wrong (it answered 1 for 15 rows), so the source side is judged by a
  full scan.

Result at cutover (source read with the receiver stopped):

| table | source rows scanned | duplicate keys dropped | target `count(*)` / scanned | row-set SHA-256 (source kept = target) |
|---|---|---|---|---|
| `pings` | 15 | 3 | 12 / 12 | `74c0bc2779189bd2…` = `74c0bc2779189bd2…` |
| `pings_weekly` | 0 | 0 | 0 / 0 | empty = empty |

The full report and an export of every source row (all 15, duplicates included) are kept on the host
under `~/backups/heliosdb-telemetry/migration-2026-10-02/`. The source rows were not deleted from
`other-service-db`.

## Backups

`ops/telemetry-db-backup.sh` (cron 01:57; `--check` hourly): raw copy of the encrypted data
directory with the engine frozen by `docker pause` (~0.4 s), restored on every run into scratch
volumes and opened with the key on an isolated network (row counts must match the live store),
uploaded to the SAN over ssh with a remote sha256 check, rotated daily 7 / weekly 4 /
monthly 3, and the newest SAN copy is downloaded and drilled weekly. Restoring needs
`DB_ENCRYPTION_KEY`.

## Verifying the post-quantum key exchange

`ops/db-tls-groups.sh telemetry-receiver 6 -- curl -s -X GET https://telemetry.danimoya.com/v1/stats`
(wait ~11 s first so the pool's idle connection closes): `4588` = X25519MLKEM768, `29` = X25519.
At cutover: ClientHello offered `4588,29`, ServerHello selected `4588`.

## Rollback copies (do not delete)

- volume `telemetry_telemetry_heliosdb` (the legacy, empty 3.32.2 store) — not declared in compose;
- images `heliosdb-nano-v2:telemetry-rollback-20261002`, `telemetry-receiver:rollback-20261002`;
- the pre-cutover compose is commit `1c4b4f5`. Commands: private runbook section 10.
