#!/usr/bin/env python3
"""Why a frozen export did not arrive, rather than a guess about the bank.

    python3 ci/test_fetch_reporting.py

`fetch` ran its downloader with `capture_output=True` and returned a bare bool, so a timeout, a
rate limit, a full disk and a genuinely absent asset were the same answer. The caller turned all
four into:

    <name>.export.gz is not in the store

which says the bank is missing the evidence for a record. Read by anyone who did not run the
command themselves, that is the bank admitting a record cannot be re-derived.

Measured on 2026-09-28: a re-derivation reported MTH.R-2026-6022's export "is not in the store"
while the asset sat in the release at 64 MB and `publish-bank-export.sh --audit` reported that
the release and the record agreed. One of 33 downloads totalling 645 MB had failed. The corpus
was fine and the message said otherwise.

Same shape as a runner exhausting its disk and surfacing as "reject — submission.lean failed to
build", recorded against a depositor whose proof was fine.

No network: every case here is a local store or a deliberately absent name.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_ld = SourceFileLoader("mathesis_cli", str(ROOT / "bin" / "mathesis"))
cli = importlib.util.module_from_spec(importlib.util.spec_from_loader("mathesis_cli", _ld))
_ld.exec_module(cli)

PASSES: list[str] = []
FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASSES if ok else FAILURES).append(name if ok else f"{name}: {detail}")
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


cache = Path(tempfile.mkdtemp())
store = Path(tempfile.mkdtemp())
os.environ["BANK_EXPORT_STORE"] = str(store)

# Success is None. Anything else is a reason, and a reason is a string.
(store / "present.export.gz").write_bytes(b"EXPORT")
check("an_export_that_arrives_reports_nothing", cli.fetch("present.export.gz", cache) is None)

# The cache short-circuit: a second call must not re-fetch, and must still say nothing.
check("a_cached_export_reports_nothing", cli.fetch("present.export.gz", cache) is None)

why = cli.fetch("absent.export.gz", cache)
check("an_absent_export_says_where_it_looked",
      isinstance(why, str) and "absent.export.gz" in why, repr(why))

# The case that matters: the reason distinguishes a missing ASSET from a missing RELEASE, which
# is the difference between "this record has no evidence" and "the download did not happen".
os.environ["BANK_EXPORT_STORE"] = "gh:example/nothing@no-such-tag"
why = cli.fetch("whatever.export.gz", cache)
check("a_failed_download_reports_the_downloaders_own_words",
      isinstance(why, str) and why != "" and "is not in the store" not in why, repr(why))

# And the sentence the old code produced must not be reachable from any of them: it asserts a
# fact about the bank that `fetch` is in no position to know.
os.environ["BANK_EXPORT_STORE"] = str(store)
for name in ("absent.export.gz", "present.export.gz"):
    r = cli.fetch(name, cache)
    check(f"no_reason_claims_the_store_is_missing_it ({name})",
          r is None or "is not in the store" not in r, repr(r))

print()
print(f"{len(PASSES)} passed, {len(FAILURES)} failed")
sys.exit(1 if FAILURES else 0)
