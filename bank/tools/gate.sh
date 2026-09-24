#!/usr/bin/env bash
# gate.sh <Module> <Decl> — freeze one result's export and adjudicate it.
#
#   LEAN_PROJECT        the lake project that builds <Module> (run as `lake env`)
#   LEAN4EXPORT         the lean4export binary (v3.1.0 format)
#   MATHESIS_ADJUDICATE the gate binary built from backend-gate/
#   MATHESIS_INIT_EXPORT the trusted init.export (default: backend-gate/init.export)
#   OUT                 where <Decl>.export.gz, .export.sha256, .export.bytes and
#                       .verdict.json are written (default: ./exports)
set -euo pipefail
mod="$1"; decl="$2"
here="$(cd "$(dirname "$0")/../.." && pwd)"
: "${LEAN_PROJECT:?}" "${LEAN4EXPORT:?}" "${MATHESIS_ADJUDICATE:?}"
init="${MATHESIS_INIT_EXPORT:-$here/backend-gate/init.export}"
out="${OUT:-$PWD/exports}"; mkdir -p "$out"; f="$out/$decl"
(cd "$LEAN_PROJECT" && lake env "$LEAN4EXPORT" "$mod" -- "$decl") > "$f.export"
MATHESIS_INIT_EXPORT="$init" "$MATHESIS_ADJUDICATE" "$f.export" -- "$decl" > "$f.verdict.json" || true
shasum -a 256 "$f.export" | cut -c1-64 > "$f.export.sha256"
wc -c < "$f.export" | tr -d ' ' > "$f.export.bytes"
gzip -f -9 "$f.export"
python3 - "$f.verdict.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); t = d["targets"][0]
print(d["verdict"], "replay=" + str(d["replay"]["accepted"]), "axioms=" + ",".join(t["axioms_reached"]))
sys.exit(0 if d["verdict"] == "ADMITTED" else 1)
PY
