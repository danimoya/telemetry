#!/usr/bin/env python3
"""Copies the telemetry receiver's tables into a fresh, encrypted HeliosDB-Nano 4.41 store, then
proves it.

    copy_telemetry.py [--schema] [--copy] [--report FILE] [--export FILE]
    SOURCE_DSN / TARGET_DSN come from the environment (keeps passwords out of the process list).

Where the rows really were (found 2026-10-02): the receiver's PG_URL host `heliosdb` resolved, over
the shared management-network, to another service's HeliosDB-Full container (network
alias `heliosdb`), not to the stack's own `telemetry-heliosdb`, whose store was empty. So the
source is `other-service-db`, read-only; only `pings` and `pings_weekly` are telemetry's. The other
tables in that database belong to the other service and are neither read nor touched.

Adapted from HeliosDB Partners' scripts/nano-migrate/copy_store.py (the 2026-10-01 cutover):

* The source engine's COUNT(*) is wrong here (it answers 1 for `pings`, which holds 15 rows), so the
  source side is judged by the rows a full scan returns; COUNT(*) is reported but not trusted.
  The target must agree on both COUNT(*) and the scan.
* Reads use the simple-query protocol (psycopg ClientCursor) and take every field as raw bytes, each
  decoded by the column type the TARGET catalog declares.
* --schema creates the target tables with the receiver's own DDL, except that
  `pings.received_at` has no NOT NULL: the source holds one row (week 2026-40) with a NULL there
  despite DEFAULT now(), and that row is copied as it is.
* Writes: one transaction per table, every placeholder in text format with an explicit cast.
* Verification (always, and the exit status): table presence, same column set per table, row
  counts, and an order-independent SHA-256 over every row in a canonical typed form.
  Nothing is ever deleted: --copy refuses a target table that already holds rows.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys

import psycopg
from psycopg.adapt import Loader

# Target DDL: mirrors receiver/server.js ensureSchema() (see the module note on pings.received_at).
SCHEMA = [
    """CREATE TABLE IF NOT EXISTS pings (
         week_bucket        TEXT NOT NULL,
         hash               TEXT NOT NULL,
         dashboard_version  TEXT NOT NULL,
         heliosdb_version   TEXT,
         received_at        TIMESTAMPTZ DEFAULT now(),
         PRIMARY KEY (week_bucket, hash)
       )""",
    "CREATE INDEX IF NOT EXISTS pings_week_idx ON pings (week_bucket)",
    "CREATE INDEX IF NOT EXISTS pings_received_idx ON pings (received_at)",
    """CREATE TABLE IF NOT EXISTS pings_weekly (
         week_bucket  TEXT NOT NULL,
         installs     INTEGER NOT NULL,
         finalised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (week_bucket)
       )""",
]
TABLES = ["pings", "pings_weekly"]
# Primary key and "which row the receiver would have kept" per table. The source engine did not
# enforce the primary key: `INSERT ... ON CONFLICT (week_bucket, hash) DO NOTHING` stored 3 duplicate
# pairs (same week + hash, a few seconds apart). The target enforces it, so the copy keeps what
# DO NOTHING means: the FIRST row per key (earliest timestamp; a NULL timestamp sorts last). Every
# dropped duplicate is listed in the report, and --export keeps all source rows as they were.
# The stats only ever use COUNT(DISTINCT hash), so no published number changes.
KEYS = {"pings": (("week_bucket", "hash"), "received_at"), "pings_weekly": (("week_bucket",), "finalised_at")}


class RawLoader(Loader):
    def load(self, data):
        return bytes(data)


RAW_TYPES = ("text", "varchar", "bpchar", "name", "timestamp", "timestamptz", "date", "bool",
             "int2", "int4", "int8", "float4", "float8", "numeric", "oid")


def connect(dsn: str, raw: bool) -> psycopg.Connection:
    conn = psycopg.connect(dsn, autocommit=True, prepare_threshold=None, cursor_factory=psycopg.ClientCursor)
    if raw:
        for name in RAW_TYPES:
            conn.adapters.register_loader(name, RawLoader)
    return conn


def q(ident: str) -> str:
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", ident):
        raise ValueError(f"unexpected identifier {ident!r}")
    return ident


def kind_cast(data_type: str) -> tuple[str, str]:
    t = data_type.lower()
    if t in ("text",) or t.startswith("varchar") or t.startswith("char"):
        return "text", "text"
    if t in ("integer", "int4", "int", "bigint", "int8", "smallint", "int2"):
        return "int", "bigint" if t in ("bigint", "int8") else "integer"
    if t in ("timestamptz", "timestamp with time zone"):
        return "timestamptz", "timestamptz"
    raise ValueError(f"unmapped column type {data_type!r}")


def target_schema(tgt) -> dict:
    out = {}
    for t in TABLES:
        cols = tgt.execute(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = %s ORDER BY ordinal_position",
            (t,)).fetchall()
        if not cols:
            raise SystemExit(f"target has no table {t}; run with --schema first")
        out[t] = [(c, *kind_cast(d)) for c, d in cols]
    return out


def parse_ts(s: str) -> dt.datetime:
    s = s.strip().replace("T", " ")
    m = re.fullmatch(r"(.*?)([+-]\d\d(?::?\d\d)?|Z)?", s)
    body, off = m.group(1), m.group(2)
    tz = None
    if off:
        if off == "Z":
            tz = dt.timezone.utc
        else:
            sign = 1 if off[0] == "+" else -1
            hh, mm = int(off[1:3]), (int(off[-2:]) if len(off) > 3 else 0)
            tz = dt.timezone(sign * dt.timedelta(hours=hh, minutes=mm))
    v = dt.datetime.strptime(body, "%Y-%m-%d %H:%M:%S.%f" if "." in body else "%Y-%m-%d %H:%M:%S")
    return v.replace(tzinfo=tz or dt.timezone.utc)


def decode(raw, kind):
    if raw is None:
        return None
    s = raw.decode("utf-8")
    if kind == "text":
        return s
    if kind == "int":
        return int(s)
    if kind == "timestamptz":
        return parse_ts(s)
    raise ValueError(kind)


def canonical(v):
    if isinstance(v, dt.datetime):
        return {"ts": v.astimezone(dt.timezone.utc).replace(tzinfo=None).isoformat(timespec="microseconds")}
    return v


def read_table(conn, table, cols):
    cur = conn.cursor()
    cur.execute(f"SELECT {', '.join(q(c) for c, _, _ in cols)} FROM {q(table)}")
    rows = [tuple(decode(v, k) for v, (_, k, _) in zip(r, cols)) for r in cur.fetchall()]
    cur.execute(f"SELECT COUNT(*) FROM {q(table)}")
    return rows, _count(cur)


def _count(cur):
    v = cur.fetchone()[0]
    return int(v.decode() if isinstance(v, (bytes, bytearray)) else v)


def dedupe(table, rows, cols):
    """(kept rows, dropped rows): first row per primary key, ordered by the table's timestamp."""
    names = [c for c, _, _ in cols]
    key_cols, ts_col = KEYS[table]
    ki, ti = [names.index(k) for k in key_cols], names.index(ts_col)
    ordered = sorted(rows, key=lambda r: (r[ti] is None, r[ti] or dt.datetime.min.replace(tzinfo=dt.timezone.utc)))
    seen, kept, dropped = set(), [], []
    for r in ordered:
        k = tuple(r[i] for i in ki)
        (dropped if k in seen else kept).append(r)
        seen.add(k)
    return kept, dropped


def digest(rows, cols) -> str:
    names = [c for c, _, _ in cols]
    hashes = sorted(hashlib.sha256(json.dumps(dict(zip(names, map(canonical, r))), sort_keys=True,
                                              separators=(",", ":")).encode()).hexdigest() for r in rows)
    return hashlib.sha256("\n".join(hashes).encode()).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--schema", action="store_true", help="create the target tables first")
    ap.add_argument("--copy", action="store_true")
    ap.add_argument("--report")
    ap.add_argument("--export", help="also write every source row (canonical JSON) to this file")
    a = ap.parse_args()
    src_dsn, tgt_dsn = os.environ.get("SOURCE_DSN"), os.environ.get("TARGET_DSN")
    if not src_dsn or not tgt_dsn:
        ap.error("SOURCE_DSN and TARGET_DSN are required in the environment")
    src = connect(src_dsn, raw=True)
    tgt_raw = connect(tgt_dsn, raw=True)
    tgt = connect(tgt_dsn, raw=False)
    for side, conn in (("source", src), ("target", tgt)):
        v = conn.execute("SELECT version()").fetchone()[0]
        print(f"{side}: {v.decode() if isinstance(v, bytes) else v}", flush=True)
    print(f"target TLS: {tgt.pgconn.ssl_in_use}  source TLS: {src.pgconn.ssl_in_use}", flush=True)
    if a.schema:
        for stmt in SCHEMA:
            tgt.execute(stmt)
        print("target schema created", flush=True)
    schema = target_schema(tgt)

    if a.copy:
        for table in TABLES:
            cols = schema[table]
            n = _count(tgt.execute(f"SELECT COUNT(*) FROM {q(table)}"))
            if n:
                sys.exit(f"{table}: target already holds {n} rows; refusing to copy")
            rows, _ = read_table(src, table, cols)
            rows, dropped = dedupe(table, rows, cols)
            names = ", ".join(q(c) for c, _, _ in cols)
            marks = ", ".join(f"%t::{cast}" for _, _, cast in cols)
            with tgt.transaction():
                with tgt.cursor() as cur:
                    for r in rows:
                        cur.execute(f"INSERT INTO {q(table)} ({names}) VALUES ({marks})", r)
            print(f"copied {table:14s} {len(rows):6d} rows ({len(dropped)} duplicate-key rows not copied)", flush=True)

    if a.export:
        dump = {}
        for table in TABLES:
            rows, _ = read_table(src, table, schema[table])
            dump[table] = {"columns": [c for c, _, _ in schema[table]],
                           "rows": [[canonical(v) for v in r] for r in rows]}
        with open(a.export, "w") as f:
            json.dump(dump, f, indent=1, sort_keys=True)
        print(f"exported source rows to {a.export}", flush=True)

    report = {"tables": {}, "ok": True}
    src_tables = {(r[0].decode() if isinstance(r[0], bytes) else r[0]) for r in src.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'").fetchall()}
    tgt_tables = {r[0] for r in tgt.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'").fetchall()}
    report["source_tables"], report["target_tables"] = sorted(src_tables), sorted(tgt_tables)
    # The source is a shared database (it also holds the other service's own tables): only the
    # telemetry tables are copied and compared. The target must hold exactly those.
    if not set(TABLES) <= src_tables or tgt_tables != set(TABLES):
        report["ok"] = False
    for table in TABLES:
        cols = schema[table]
        scur = src.cursor()
        scur.execute(f"SELECT * FROM {q(table)} LIMIT 0")
        scols = {d.name for d in scur.description}
        entry = {}
        if scols != {c for c, _, _ in cols}:
            entry["column_mismatch"] = sorted(scols ^ {c for c, _, _ in cols})
        s_all, s_count = read_table(src, table, cols)
        s_rows, dropped = dedupe(table, s_all, cols)
        t_rows, t_count = read_table(tgt_raw, table, cols)
        entry.update(source_count_reported=s_count, source_scanned=len(s_all), source_all_rows_sha256=digest(s_all, cols),
                     source_duplicates_dropped=[[canonical(v) for v in r] for r in dropped],
                     source_kept=len(s_rows), target_count=t_count, target_scanned=len(t_rows),
                     source_sha256=digest(s_rows, cols), target_sha256=digest(t_rows, cols))
        entry["ok"] = ("column_mismatch" not in entry and len(s_rows) == t_count == len(t_rows)
                       and entry["source_sha256"] == entry["target_sha256"])
        report["ok"] &= entry["ok"]
        report["tables"][table] = entry
        print(f"{'ok ' if entry['ok'] else 'BAD'} {table:14s} src scan {len(s_all):5d} (count(*) says {s_count:5d}, "
              f"{len(dropped)} duplicate keys) kept {len(s_rows):5d}  "
              f"tgt {t_count:5d}/{len(t_rows):5d}  {entry['source_sha256'][:16]} "
              f"{'==' if entry['source_sha256'] == entry['target_sha256'] else '!='} {entry['target_sha256'][:16]}", flush=True)
    report["rows"] = sum(e["target_scanned"] for e in report["tables"].values())
    if a.report:
        with open(a.report, "w") as f:
            json.dump(report, f, indent=2, sort_keys=True)
    print(f"{'VERIFIED' if report['ok'] else 'MISMATCH'}: {len(report['tables'])} tables, {report['rows']} rows on the target")
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
