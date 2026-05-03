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
