# telemetry

Cross-product anonymous-install ping receiver. Backs the "X anonymous active installs reporting pings this week" number for Claude-Dashboard, Claude-B, and any other tool in the family that opts in.

This is a **private** repo — published only as a reference for due-diligence reviewers and investors who want to verify the data-handling posture. Each product's source repo links to this file from its `/telemetry` page.

## What it does

Accepts a single endpoint:

```
POST /v1/ping
Content-Type: application/json

{
  "installation_id":  "...random hex...",
  "dashboard_version": "1.4.2",
  "heliosdb_version":  "3.19.1",
  "timestamp":         "2026-05-03T12:34:56Z"
}
```

For each request, the receiver does:

1. Pulls the client IP from the connection (TLS-terminated edge).
2. Computes `hash = SHA-256(salt_<YYYY-W> || ip || installation_id)` where `salt_<YYYY-W>` is the salt for the current ISO week, kept in the receiver's memory and in a root/receiver-only file (see below).
3. INSERTs `(week_bucket, hash, dashboard_version, heliosdb_version, received_at)` into the `pings` table, with a unique constraint on `(week_bucket, hash)` so duplicate posts within the same week are silent no-ops.
4. **Drops the IP and the raw `(ip, installation_id)` tuple immediately.** Neither is logged, written to disk, or forwarded.

### Salt persistence and rotation

The receiver stores the current week's salt at `SALT_FILE` as `<YYYY-WW> <64 hex>` (mode 0600) on
the persistent `telemetry_salt` volume (`receiver/persisted-salt.js`). A restart during the week
keeps the salt, so an installation that pings again after the restart keeps its hash and is counted
once. The first ping of a new ISO week replaces the file with a fresh random salt, so last week's
salt is gone and hashes from different weeks cannot be linked. A missing volume or a malformed file
stops the receiver; it never falls back to a temporary salt. Do not put the salt path on `tmpfs`: a
restart would lose the salt and count installations twice.

Until 2026-10-02 the salt was in memory only, and every receiver restart started a new salt. A
restart in the middle of a week could therefore count an installation twice in that week (for
example week 2026-40, where the receiver was restarted on Friday 2026-10-02). The weekly
`salt-rotate.cron` job was not installed on the host (checked 2026-10-02), so between restarts the
same salt was also used across weeks; the week number is part of every hash, so equal inputs still
gave different hashes in different weeks.

The "weekly active installs" count is a single SQL query:

```sql
SELECT COUNT(DISTINCT hash) AS installs
  FROM pings
 WHERE week_bucket = (
   to_char(now() AT TIME ZONE 'utc', 'IYYY-IW')
 );
```

Per-row data is dropped after **90 days**: every Monday `receiver/finalise-week.sh` stores each completed week's count in `pings_weekly`, then deletes the rows of every ISO week that ended more than 90 days ago, so a row is gone within 97 days. Aggregate counts are kept indefinitely. Encrypted backups of the store are kept for up to 3 months.

## What it does NOT do

- Does not store IP addresses (raw or transformed) past the duration of a single request handler.
- Does not store the raw `installation_id` after hashing.
- Does not call out to third-party services (no analytics SDK, no log forwarder).
- Does not correlate hashes across weeks. Salts rotate weekly; hashes from week N cannot be matched to hashes from week N+1.
- Does not collect a username, email, project name, command output, prompt text, or any session content. The dashboard's source code makes the entire payload visible — there's no separate channel.

## Layout

```
telemetry/
├── README.md          # this file
├── docker-compose.yml # telemetry-heliosdb (Nano 4.41, encrypted, PQC TLS) + receiver
├── receiver/          # Node/Fastify app — single endpoint, single table
│   ├── server.js
│   ├── entrypoint.sh  # reads the DB password from the compose secret, drops root
│   └── package.json
├── db/nano/           # HeliosDB-Nano 4.41.0 image (official release, sha256-pinned)
├── db/migrate/        # copy + verify tool used for the 2026-10-02 cutover
├── ops/               # encrypted backup + restore drill + SAN rotation; TLS group check
├── docs/              # NANO-4.41-MIGRATION.md
├── schema.sql         # pings table + retention job
├── salt-rotate.cron   # weekly jobs (salt rotation is now in the receiver; finalise-week)
└── ROOM-FOR-AUDIT.md  # changelog of policy changes (append-only)
```

## Storage

The rows live in a dedicated HeliosDB-Nano 4.41.0 store, encrypted at rest (AES-256-GCM), reached
only over TLS 1.3 with the X25519MLKEM768 post-quantum hybrid key exchange and SCRAM-SHA-256, on an
internal Docker network. Details, and how the rows were moved there: `docs/NANO-4.41-MIGRATION.md`.

What enforces the TLS part: the receiver's connection settings (`sslmode=verify-full`, Node 24 with
OpenSSL 3.5, which offers X25519MLKEM768), and the fact that the receiver is the only thing that can
reach the database. The engine itself (Nano 4.41) still accepts plaintext and classical-only TLS
connections (HeliosDB-Nano #53), so the network is locked down: no published port, an internal
network, and no host address on it, so no process on the host can connect either.

## Why publish this

The "what's it sending?" question always comes up. Publishing the receiver — including the cron jobs, the salt-rotation script, and the SQL — is the cheapest way to answer it definitively. The dashboard's own `/telemetry` page links here. The disclosure is the load-bearing thing; the implementation is small.
