#!/usr/bin/env python3
"""Measure a lean4export artifact: size, sha256, format version, constant count by kind.

    python3 ci/export_stats.py backend-gate/init.export
    python3 ci/export_stats.py mathlib.export --json

WHAT THIS IS FOR
----------------
Reference exports are pinned by content address (`environments.init_reference_sha256` and
`environments.mathlib_reference_sha256`), so producing one means reporting exactly what was
produced. This is that report. It also makes the plan's "measure its size, do not extrapolate"
checkable: `frozen_export.constants` across the banked corpus is 337 MB/247, 129 MB/26035 and
74 MB/12, so bytes-per-constant means different things in different rows and cannot be
extrapolated from.

WHAT THIS IS NOT
----------------
**Not authoritative.** The authority on what an export means is `loadFrozenText`
(`backend-gate/Mathesis/Manifest.lean`), and the authority on whether one is acceptable is
`mathesis-adjudicate`. This reads the same bytes for reporting only: it never decides whether
an export is valid, and a clean report here is not an admission of anything.

THE FORMAT
----------
NDJSON, one record per line, lean4export format 3.1.0. Records divide into interning tables and
declarations:

    {"meta":{...}}                     one header: exporter / format / lean version
    {"in":N,"str":{...}} / {"in":N,"num":{...}}   name table
    {"ie":N,...}                       expression table
    {"il":N,...}                       level table
    {"def"|"thm"|"axiom"|"opaque"|"quot":{...}}   one constant each
    {"inductive":{"types":[...],"ctors":[...],"recs":[...]}}   SEVERAL constants

Table records carry an `in`/`ie`/`il` key and declarations carry none, which is the
discriminator used below.

An `inductive` record is the reason a naive line count understates the truth: it bundles the
inductive type with its constructors and recursors, each of which is a separate constant the
trusted-redefinition check can match against. Counting records instead of constants reports 457
for `init.export`, whose documented content is **563 constants** — and 563 is what this produces,
which is the regression test for this file (`--self-test`).
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import sys
from pathlib import Path

# Keys that mark an interning-table record rather than a declaration.
TABLE_KEYS = ("in", "ie", "il")


def measure(path: Path) -> dict:
    """Stream the file once. Never loads it whole: a Mathlib-scale reference is gigabytes."""
    h = hashlib.sha256()
    size = 0
    lines = 0
    tables = 0
    unparseable = 0
    meta: dict = {}
    kinds: collections.Counter = collections.Counter()
    # Constants are collected as (kind, name-id) pairs rather than counted, because an
    # `inductive` record can name a constant that also appears in another record's closure.
    names: set[tuple[str, object]] = set()

    with path.open("rb") as fh:
        for raw in fh:
            h.update(raw)
            size += len(raw)
            line = raw.strip()
            if not line:
                continue
            lines += 1
            try:
                rec = json.loads(line)
            except Exception:
                unparseable += 1
                continue
            if any(k in rec for k in TABLE_KEYS):
                tables += 1
                continue
            kind = next(iter(rec))
            if kind == "meta":
                meta = rec["meta"]
                continue
            body = rec[kind]
            if kind == "inductive":
                for t in body.get("types", []):
                    names.add(("inductive", t["name"]))
                    kinds["inductive type"] += 1
                for c in body.get("ctors", []):
                    names.add(("ctor", c["name"]))
                    kinds["constructor"] += 1
                for r in body.get("recs", []):
                    names.add(("rec", r["name"]))
                    kinds["recursor"] += 1
            else:
                names.add((kind, body.get("name") if isinstance(body, dict) else None))
                kinds[kind] += 1

    return {
        "path": str(path),
        "bytes": size,
        "sha256": h.hexdigest(),
        "lines": lines,
        "table_records": tables,
        "unparseable_lines": unparseable,
        "constants": len(names),
        "kinds": dict(kinds.most_common()),
        "exporter": (meta.get("exporter") or {}).get("version"),
        "format": (meta.get("format") or {}).get("version"),
        "lean": (meta.get("lean") or {}).get("version"),
        "lean_githash": (meta.get("lean") or {}).get("githash"),
    }


def human(n: int) -> str:
    x = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if x < 1024 or unit == "GB":
            return f"{x:.1f} {unit}" if unit != "B" else f"{int(x)} B"
        x /= 1024
    return f"{x:.1f} GB"


def report(st: dict) -> None:
    print(f"  file        {st['path']}")
    print(f"  size        {human(st['bytes'])}  ({st['bytes']:,} bytes)")
    print(f"  sha256      {st['sha256']}")
    print(f"  exporter    lean4export {st['exporter']}  format {st['format']}")
    print(f"  lean        {st['lean']}  ({str(st['lean_githash'])[:12]})")
    print(f"  constants   {st['constants']:,}")
    if st["constants"]:
        print(f"  bytes/const {st['bytes'] / st['constants']:,.0f}")
    print(f"  records     {st['lines']:,} lines, {st['table_records']:,} table entries")
    if st["unparseable_lines"]:
        # Not a verdict — but a reference is supposed to be complete NDJSON, and lean4export can
        # panic yet still exit 0, so a truncated tail shows up here as unparseable.
        print(f"  UNPARSEABLE {st['unparseable_lines']:,} line(s) — export may be truncated")
    print("  by kind:")
    for k, v in st["kinds"].items():
        print(f"    {v:8,d}  {k}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("export", nargs="?", help="path to a .export file")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--self-test", action="store_true",
                    help="assert init.export measures 563 constants (its documented content)")
    args = ap.parse_args()

    if args.self_test:
        root = Path(__file__).resolve().parent.parent
        init = root / "backend-gate" / "init.export"
        if not init.exists():
            print(f"FATAL: {init} absent")
            return 2
        st = measure(init)
        ok = st["constants"] == 563
        print(f"  init.export constants = {st['constants']} (expected 563): "
              f"{'PASS' if ok else 'FAIL'}")
        if not ok:
            print("  the counter disagrees with init.export.README.md — one of them is wrong")
        return 0 if ok else 1

    if not args.export:
        ap.error("give a .export path, or --self-test")
    path = Path(args.export)
    if not path.exists():
        print(f"FATAL: {path} does not exist")
        return 2
    st = measure(path)
    if args.json:
        json.dump(st, sys.stdout, indent=2, sort_keys=True)
        print()
    else:
        report(st)
    return 0


if __name__ == "__main__":
    sys.exit(main())
