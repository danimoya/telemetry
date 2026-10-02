# Telemetry store on HeliosDB-Nano 4.41.0 — encrypted at rest, post-quantum TLS

Cut over 2026-10-02 (09:23:43–09:23:56 UTC, 12.5 s without a receiver). Secrets and the operator
procedures (keys, backup, restore, rotation, rollback) live in the private runbook
the private operations runbook, never here.

## What runs now

| | |
|---|---|
| Engine | official HeliosDB-Nano **v4.41.0** release binary on `debian:trixie-slim` (`db/nano/`, sha256-pinned; the binary needs glibc ≥ 2.39), image `telemetry-heliosdb:4.41.0` |
| At rest | `[encryption] enabled`, AES-256-GCM on every stored value (keys/table names stay visible on disk, as documented by Nano) |
| In transit | TLS 1.3 with `--tls-post-quantum`: the server picks **X25519MLKEM768** (hybrid ML-KEM-768 + X25519) when the client offers it. The server does **not** require it: it also accepts plaintext and classical-only groups (X25519, P-256). See "What enforces TLS and the post-quantum group" below |
| Auth | SCRAM-SHA-256, bootstrap role `postgres` (SQL-created roles cannot log in with SCRAM on 4.41, HeliosDB-Nano #49) |
| Durability | `storage.durable_commit = true` (fsync at COMMIT) |
| Network | `telemetry_db` (internal, 10.250.20.0/24, `inhibit_ipv4`: the host has no address on it); only the receiver joins it; no published port; HTTP/MCP listener off |
| Secrets | `/etc/heliosdb-telemetry/db.env` (root, 0600): `DB_PASSWORD`, `DB_ENCRYPTION_KEY`, compose secret `telemetry_db`, mounted in the engine only. `/etc/heliosdb-telemetry/receiver.env` (root, 0600): `DB_PASSWORD` only, compose secret `telemetry_db_client`, mounted in the receiver. Both are written by `ops/rotate-db-password.sh`. Both entrypoints start as root only to read their file, then drop to uid 999 (DB) / 1000 `node` (receiver); the receiver exports the password as `PGPASSWORD`, and `PG_URL` carries none. Root on the host, or `docker exec` (root in the container), can read the mounted file and the processes' environment |
| Password on the command line | Nano 4.41 takes the password only as `--password` (no environment variable or file option, HeliosDB-Nano #38). The entrypoint starts `nano-mask-argv` (`db/nano/mask-argv.pl`), which overwrites the value with `*` in the engine's argv once it listens, so `/proc/<pid>/cmdline` and `ps` show `--password ****…`. The value is readable from exec until the listener is up (under a second, at each engine start). The hourly `ops/telemetry-db-backup.sh --check` alerts if the value is ever visible |
| Volumes | `telemetry_telemetry_heliosdb_441` (store), `telemetry_telemetry_heliosdb_tls` (key + cert, DB only), `telemetry_telemetry_heliosdb_tlspub` (cert only, read-only in the receiver) |
| Client | receiver on `node:24-trixie-slim` (Node 24.21, OpenSSL 3.5.8): `PG_URL=postgresql://postgres@telemetry-heliosdb:5432/heliosdb?sslmode=verify-full&sslrootcert=/tls-pub/server.crt` — node-postgres pins the self-signed certificate and checks the host name |

**Losing `DB_ENCRYPTION_KEY` loses the store.** Nano verifies a sealed sentinel on every open, so a
wrong key is refused (checked in the rehearsal); there is no key rotation in 4.41 — re-keying is a
copy into a fresh store (`db/migrate/copy_telemetry.py` works 4.x → 4.x as well).

## What enforces TLS and the post-quantum group

Not the server. Nano 4.41 `start` hard-codes `SslMode::Prefer` (HeliosDB-Nano #53): the engine
accepts a plaintext client (it goes on to the SCRAM exchange without TLS), and with TLS it accepts a
client that offers only classical groups (`openssl s_client -starttls postgres -groups X25519`, or
`P-256`, connects). `--tls-post-quantum` adds X25519MLKEM768 and prefers it, but does not require it.

So "every connection uses TLS with X25519MLKEM768" holds because of two things:

1. **The only client.** The receiver connects with `sslmode=verify-full` and offers 4588 first
   (Node 24, OpenSSL 3.5); `ops/db-tls-groups.sh` shows the ServerHello group.
2. **Who can reach the port.** `telemetry_db` is `internal` with no published port, the receiver is
   the only container on it, and since 2026-10-02 the bridge has no host address
   (`com.docker.network.bridge.inhibit_ipv4`), so no host process can open a connection either.
   Before that change, any local user could connect to `10.250.20.x:5432` from the host.

Root on the host can still join the network namespace and connect any way it likes.

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

## Corrections and fixes after the cutover (2026-10-02, later the same day)

A review of the cutover found statements above that were not accurate, and gaps. Fixed:

- **The password was readable by every local user.** It was in the engine's argv
  (`--password …`), and on this host `/proc` is not mounted with `hidepid`, so any account could
  read it through `/proc/<pid>/cmdline` or `ps`. Fix: `nano-mask-argv` (above), the host can no
  longer reach the database at all, and the password was rotated (`ops/rotate-db-password.sh`).
  Hiding all processes host-wide (`hidepid=2`) was not done: on this host it would also hide
  processes from root daemons that run without `CAP_SYS_PTRACE` (systemd-logind, polkit) and from
  running sessions. A proper fix needs an environment variable or file option for the password in
  Nano (HeliosDB-Nano #38, open).
- **"The receiver gets only the password" was wrong.** The receiver mounted the whole `db.env`,
  encryption key included. It now gets `receiver.env`, which holds the password only.
- **The server does not enforce TLS or the post-quantum group.** See "What enforces TLS and the
  post-quantum group" above.
- **Salt.** The receiver's hashing salt was in memory only, so the cutover restart (a Friday) may
  have counted an installation twice in week 2026-40. The salt is now persisted per week
  (`receiver/persisted-salt.js`, README "Salt persistence and rotation").
- **Schema drift.** The receiver's bootstrap DDL and `schema.sql` still said
  `received_at … NOT NULL`, while the live table allows NULL (see "How the data moved"). Both now
  match the live table, so a fresh store gets the same schema and accepts the migrated row.

Deployed 2026-10-02 09:47:57–09:48:14 UTC (images built from commit `6375b97`; about 17 s without a
receiver, stack recreated so the `telemetry_db` network could be rebuilt without a host address).
Rollback images: `telemetry-heliosdb:rollback-20261002-premask`,
`telemetry-receiver:rollback-20261002-presalt`; commands in the private runbook (section 10.6).
