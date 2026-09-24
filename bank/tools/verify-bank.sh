#!/usr/bin/env bash
# verify-bank.sh — re-derive every published argument from its frozen export.
#
# For each bank/arguments/*.json: fetch `<export_sha256>.export.gz` from the
# store, check that the decompressed bytes hash to the manifest's sha256 (a
# corrupted or substituted blob stops here), replay it through the gate, and
# require ADMITTED, an accepted replay, no triviality, and exactly the manifest's
# axioms. Fails closed: any miss is a nonzero exit.
#
#   MATHESIS_ADJUDICATE   the gate binary built from backend-gate/ (required)
#   MATHESIS_INIT_EXPORT  the trusted init.export (default: backend-gate/init.export)
#   BANK_EXPORT_STORE     gh:owner/repo@tag | https://base/url | /local/dir
#   BANK_EXPORTS_DIR      download cache (default: ${TMPDIR:-/tmp}/mathesis-bank-exports)
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
: "${MATHESIS_ADJUDICATE:?the gate binary}" "${BANK_EXPORT_STORE:?where the frozen exports live}"
init="${MATHESIS_INIT_EXPORT:-$here/backend-gate/init.export}"
cache="${BANK_EXPORTS_DIR:-${TMPDIR:-/tmp}/mathesis-bank-exports}"
mkdir -p "$cache"
sha256() { if command -v sha256sum >/dev/null; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi; }

fetch() {
  local name="$1"
  [ -s "$cache/$name" ] && return 0
  case "$BANK_EXPORT_STORE" in
    gh:*)
      local spec="${BANK_EXPORT_STORE#gh:}"
      gh release download "${spec#*@}" -R "${spec%@*}" -p "$name" -D "$cache" --clobber ;;
    http://*|https://*)
      curl -fsSL -o "$cache/$name" "${BANK_EXPORT_STORE%/}/$name" ;;
    *)
      cp "$BANK_EXPORT_STORE/$name" "$cache/$name" ;;
  esac
}

pass=0; fail=0
for manifest in "$here"/bank/arguments/*.json; do
  read -r acc sha decl axioms < <(python3 - "$manifest" <<'PY'
import json, sys
a = json.load(open(sys.argv[1]))["argument"]
print(a["accession"], a["export_sha256"], a["root_decl_name"], ",".join(sorted(a["axioms_reached"])))
PY
)
  name="$sha.export.gz"
  if ! fetch "$name"; then echo "FAIL $acc: $name is not in the store"; fail=$((fail + 1)); continue; fi
  got="$(gunzip -c "$cache/$name" | sha256)"
  if [ "$got" != "$sha" ]; then echo "FAIL $acc: blob hashes to $got, manifest says $sha"; fail=$((fail + 1)); continue; fi
  work="$(mktemp -d)"
  gunzip -c "$cache/$name" > "$work/candidate.export"
  MATHESIS_INIT_EXPORT="$init" "$MATHESIS_ADJUDICATE" "$work/candidate.export" -- "$decl" > "$work/verdict.json" || true
  if python3 - "$work/verdict.json" "$decl" "$axioms" <<'PY'
import json, sys
path, decl, axioms = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))
t = next((t for t in d["targets"] if t["decl"] == decl), None)
ok = (d["verdict"] == "ADMITTED" and d["replay"]["accepted"] and t is not None
      and t["triviality"] is None
      and ",".join(sorted(t["axioms_reached"])) == axioms)
print(d["verdict"], ",".join(sorted(t["axioms_reached"])) if t else "no target")
sys.exit(0 if ok else 1)
PY
  then echo "ok   $acc $decl"; pass=$((pass + 1))
  else echo "FAIL $acc $decl"; fail=$((fail + 1)); fi
  rm -rf "$work"
done
echo "bank: $pass admitted, $fail failed"
[ "$fail" -eq 0 ] && [ "$pass" -gt 0 ]
