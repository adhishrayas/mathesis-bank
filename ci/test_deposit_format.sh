#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# The single-file deposit format: import hoisting, and the three implementations agreeing.
#
#   bash ci/test_deposit_format.sh
#
# WHY HOISTING EXISTS
# -------------------
# `/-! ... -/` is a Lean *module docstring* — declaration-level syntax — and Lean requires every
# `import` to precede all declarations. So the original shape, header first and source after,
# cannot import anything:
#
#     /-! @kind: result ... -/
#     import Mathlib.Logic.Basic   -> invalid 'import' command, it must be used in the
#                                     beginning of the file
#
# Measured directly: `/-!` then import FAILS; import then `/-!` builds; a plain `/- -/` comment
# then import builds. That shut form-raised deposits out of Mathlib entirely — the vocabulary all
# 512 banked accessions are written in — so a leading run of `import` lines is hoisted above the
# header instead.
#
# TWO IMPLEMENTATIONS, ONE RULE
# ----------------------------
# `ci/parse_deposit.py` is the authority and owns `split_leading_imports`. `site/deposit.js`
# cannot share that code, being another language, so this pins the two against each other — the
# "mirrors buildFile exactly" claim had no automated check before.
#
# The private backend's assembler is held to the same rule by its own suite, which additionally
# checks that a deposit with NO imports assembles byte-for-byte as it did before hoisting
# existed. That file is not in this repo; what IS here is the authority it must agree with.
# ---------------------------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PYTHON:-python3}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0; skip=0

check() { # check <name> <cond-cmd...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then printf '  PASS  %s\n' "$name"; pass=$((pass+1))
  else printf '  FAIL  %s\n' "$name"; fail=$((fail+1)); fi
}

echo "deposit format (import hoisting)"
echo

HDR='/-!\n# Mathesis deposit\n\n@kind: result\n@title: t\n@module: Submission\n@decls: t\n@pin: leanprover/lean4:v4.31.0\n\n@gloss:\n  g\n-/\n\ntheorem t : True := trivial\n'
# The same header with a Mathlib pin. A Mathlib import without one is refused (see below), so
# any fixture that imports Mathlib and is expected to PARSE has to carry the pin.
ML_HDR='/-!\n# Mathesis deposit\n\n@kind: result\n@title: t\n@module: Submission\n@decls: t\n@pin: leanprover/lean4:v4.31.0\n@mathlib: fabf563a7c95a166b8d7b6efca11c8b4dc9d911f\n\n@gloss:\n  g\n-/\n\ntheorem t : True := trivial\n'

# ---- 1. the parser accepts the hoisted shape and reports what was hoisted --------------------
printf "$HDR"                                > "$TMP/plain.lean"
printf "import Mathlib.Logic.Basic\n\n$ML_HDR" > "$TMP/hoisted.lean"
printf "$HDR\nimport Mathlib.Logic.Basic\n"   > "$TMP/below.lean"
printf "import ../evil\n\n$HDR"               > "$TMP/traversal.lean"
printf "import A;rm -rf /\n\n$HDR"            > "$TMP/meta.lean"

imports_of() { "$PY" "$ROOT/ci/parse_deposit.py" "$1" 2>/dev/null \
  | "$PY" -c 'import json,sys;print(",".join(json.load(sys.stdin)["imports"]))'; }

check "a deposit with no imports still parses"  "$PY" "$ROOT/ci/parse_deposit.py" "$TMP/plain.lean"
check "and reports no imports"                  test -z "$(imports_of "$TMP/plain.lean")"
check "a hoisted import parses"                 "$PY" "$ROOT/ci/parse_deposit.py" "$TMP/hoisted.lean"
check "and is reported"                         test "$(imports_of "$TMP/hoisted.lean")" = "Mathlib.Logic.Basic"

# An import below the header is a file that cannot build. Saying so costs nothing; letting it
# through spends a full container build to reach the same conclusion with a worse message.
check "an import BELOW the header is refused"   bash -c \
  "! '$PY' '$ROOT/ci/parse_deposit.py' '$TMP/below.lean' >/dev/null 2>&1"
check "the refusal explains the ordering rule"  bash -c \
  "'$PY' '$ROOT/ci/parse_deposit.py' '$TMP/below.lean' 2>&1 | grep -q 'precede all declarations'"

# The module name is interpolated verbatim into the file the gate builds, so the grammar is
# enforced rather than trusted.
check "a path-traversal module name is refused" bash -c \
  "! '$PY' '$ROOT/ci/parse_deposit.py' '$TMP/traversal.lean' >/dev/null 2>&1"
check "a metacharacter module name is refused"  bash -c \
  "! '$PY' '$ROOT/ci/parse_deposit.py' '$TMP/meta.lean' >/dev/null 2>&1"

# Importing Mathlib with no @mathlib is decidable from the header, and otherwise costs a full
# container build to discover as "unknown module prefix 'Mathlib'".
printf "import Mathlib.Logic.Basic\n\n$HDR" > "$TMP/unpinned.lean"
printf "import Mathlib.Logic.Basic\n\n$ML_HDR" > "$TMP/pinned.lean"
check "a Mathlib import with no @mathlib is refused" bash -c \
  "! '$PY' '$ROOT/ci/parse_deposit.py' '$TMP/unpinned.lean' >/dev/null 2>&1"
check "the refusal names the missing pin"            bash -c \
  "'$PY' '$ROOT/ci/parse_deposit.py' '$TMP/unpinned.lean' 2>&1 | grep -q 'no @mathlib'"
check "the same deposit WITH @mathlib parses"        "$PY" "$ROOT/ci/parse_deposit.py" "$TMP/pinned.lean"
# A core-only import must not be swept up by that check.
printf "import Init.Core\n\n$HDR" > "$TMP/coreimport.lean"
check "a non-Mathlib import needs no pin"            "$PY" "$ROOT/ci/parse_deposit.py" "$TMP/coreimport.lean"

# ---- 2. the published JS agrees with the authority -------------------------------------------
check "site/deposit.js and docs/deposit.js are in sync" cmp -s \
  "$ROOT/site/deposit.js" "$ROOT/docs/deposit.js"

if command -v node >/dev/null 2>&1; then
  # Lift the splitter out of the published file and run the SAME cases through both languages.
  # The trailing-newline and leading-blank cases are the ones that would plausibly diverge.
  cat > "$TMP/cases.json" <<'EOF'
["theorem t : True := trivial",
 "import Mathlib.Logic.Basic\n\ntheorem t : True := trivial",
 "\n\nimport A\nimport B.C\n\ntheorem t\n",
 "import A\ntheorem t",
 "import A\n\n\nimport B\n\ntheorem t\n",
 "-- a comment\nimport A\ntheorem t"]
EOF
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1] + "/site/deposit.js", "utf8");
    const m = src.match(/function splitLeadingImports[\s\S]*?\n  }\n/);
    if (!m) { console.error("splitLeadingImports not found in site/deposit.js"); process.exit(1); }
    eval(m[0].replace(/^  /gm, ""));
    const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    console.log(JSON.stringify(cases.map(splitLeadingImports)));
  ' "$ROOT" "$TMP/cases.json" > "$TMP/js.json" 2>"$TMP/js.err"
  "$PY" - "$ROOT" "$TMP/cases.json" > "$TMP/py.json" <<'PYEOF'
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("p", sys.argv[1] + "/ci/parse_deposit.py")
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
out = []
for c in json.load(open(sys.argv[2])):
    imports, body = mod.split_leading_imports(c)
    out.append({"imports": imports, "body": body})
json.dump(out, sys.stdout)
PYEOF
  check "the published JS hoist matches the parser's, case for case" bash -c \
    "'$PY' -c \"
import json,sys
a=json.load(open('$TMP/js.json')); b=json.load(open('$TMP/py.json'))
sys.exit(0 if a==b else 1)\""
else
  printf '  SKIP  JS/Python hoist equivalence (no node on PATH)\n'; skip=$((skip+1))
fi

echo
echo "  $pass passed, $fail failed, $skip skipped"
[ "$fail" -eq 0 ] || exit 1
