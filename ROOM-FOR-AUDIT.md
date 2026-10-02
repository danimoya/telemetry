# Telemetry policy changelog (append-only)

This file is the public, append-only log of every change to the receiver's
data-handling posture. Reviewers can diff older revisions against the live
schema/code to verify that the policy and the implementation agree.

---

## 2026-05-03 — initial publication

- Single endpoint `POST /v1/ping` accepting four fields:
  `installation_id`, `dashboard_version`, `heliosdb_version`, `timestamp`.
- Server-side hashing of `(salt_<YYYY-W>, client_ip, installation_id)` →
  `sha256` hex; raw IP and raw installation_id never persisted.
- Salt rotated weekly via cron; receiver restarted to pick up the new salt.
- Per-row retention: 90 days.
- Aggregate retention: indefinite (one row per ISO week + count).
- No third-party processors, no analytics SDKs.

## 2026-10-02 — dedicated encrypted store, post-quantum TLS

- Storage moved to a dedicated HeliosDB-Nano 4.41.0 store: AES-256-GCM at rest, TLS 1.3 with the
  X25519MLKEM768 hybrid key exchange, SCRAM-SHA-256, internal network only, no published port.
- Correction: from 2026-05-03 to 2026-10-02 the rows were stored, by a hostname collision on a
  shared Docker network, in the database of another service on the same host instead
  of the receiver's own store. Same fields, same host, no third party; the rows were copied to the
  new store and were not exposed outside the host. They remain in that database until the operator
  removes them.
- 3 duplicate `(week_bucket, hash)` rows (the old engine did not enforce the primary key) were
  collapsed to one row each, as the receiver always intended; published counts are unchanged.
- Fields, hashing, salt rotation and retention are unchanged.

## 2026-10-02 (later) — persisted weekly salt, corrections

- Salt: now persisted for the current ISO week (file on the receiver's private volume, mode 0600)
  and replaced by a fresh random salt at the first ping of each new week. Before this, the salt
  lived in memory only and changed at every receiver restart, so a mid-week restart could count an
  installation twice that week (possible for week 2026-40). The weekly rotation cron described in
  the 2026-05-03 entry was found not installed on the host; between restarts the same salt was used
  across weeks. Every hash includes the ISO week, so the same installation still got a different
  hash each week.
- Correction to the previous entry: the database requires neither TLS nor the post-quantum key
  exchange by itself (HeliosDB-Nano #53). Both hold because the receiver is the only client that can
  reach it and always connects with verified TLS and X25519MLKEM768. Since this change the host
  cannot reach the database network either.
- Fields, hashing inputs and retention are unchanged.
