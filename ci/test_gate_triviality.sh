#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# A vacuous statement must be flagged even when it is wearing a name, and a real one must not be.
#
#   MATHESIS_ADJUDICATE=<gate exe> LEAN4EXPORT=<lean4export exe> bash ci/test_gate_triviality.sh
#
# WHAT THIS PROTECTS
# ------------------
# The triviality flag is not a gate — a trivial theorem is kernel-valid — it is how the CI routes
# a possibly mis-claimed result to a human instead of publishing it as verified. It tested the
# conclusion exactly as written, so one definition was enough to get past it:
#
#     def Disguised : Prop := True
#     theorem rh : Disguised := trivial
#
# `stripForalls` gives the constant `Disguised`, which is not `True`. Measured on that deposit
# before the head-unfolding change: `triviality: null`, verdict ADMITTED — straight to
# publication as a clean result.
#
# The other half matters as much. Unfolding must not make the check less conservative: the gate's
# own documentation commits to never flagging a real-but-simple `2 + 2 = 4`, and `honestTwice`
# puts a submission-defined constant at the head of an honest statement so the unfolding path
# actually runs on something that must come back clean.
#
# Also asserted here: every target carries a `statement`, rendered from the term the kernel
# replayed rather than from the author's environment.
#
# Real binaries and real fixtures (ci/fixtures/gate-triviality, Init only, no Mathlib).
# ---------------------------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${MATHESIS_ADJUDICATE:?the gate binary}" "${LEAN4EXPORT:?the lean4export binary}"
# Checked, not assumed. Every assertion below reads the gate's JSON through python3, and without
# it `triv` returns an empty string that the catch-all branches read as "flagged" — so the
# vacuous cases PASSED while the honest ones failed, and the suite looked half-broken rather
# than unrunnable. A missing tool must not be able to produce a green assertion.
command -v python3 >/dev/null 2>&1 || { echo "FATAL: python3 is required to read the gate's JSON"; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1${2:+  ($2)}"; }

# The triviality string for one target of the gate's JSON line, or the literal "null".
triv() { python3 -c '
import json, sys
d = json.loads(open(sys.argv[1]).read().splitlines()[-1])
t = next((t for t in d["targets"] if t["decl"] == sys.argv[2]), None)
print("ABSENT" if t is None else (t["triviality"] or "null"))' "$TMP/$1" "$2"; }

stmt() { python3 -c '
import json, sys
d = json.loads(open(sys.argv[1]).read().splitlines()[-1])
t = next((t for t in d["targets"] if t["decl"] == sys.argv[2]), None)
print("ABSENT" if t is None else (t.get("statement") or "null"))' "$TMP/$1" "$2"; }

echo "gate triviality"
echo

cp -R "$ROOT/ci/fixtures/gate-triviality/." "$TMP/"
cp "$ROOT/backend-gate/lean-toolchain" "$TMP/"
( cd "$TMP" && lake build Cases ) > "$TMP/build.log" 2>&1 \
  || { echo "FATAL: fixtures failed to build"; tail -20 "$TMP/build.log"; exit 1; }

TARGETS="hiddenOnce hiddenChain hiddenQuantified plainTrue plainRefl honestArith honestTwice"
# shellcheck disable=SC2086
( cd "$TMP" && lake env "$LEAN4EXPORT" Cases -- $TARGETS ) > "$TMP/cases.export" 2> "$TMP/export.err" \
  || { echo "FATAL: export failed"; tail -5 "$TMP/export.err"; exit 1; }

# No --reference and no trusted export: this is about the statement, not about redefinition.
# shellcheck disable=SC2086
( cd "$TMP" && env -u MATHESIS_INIT_EXPORT "$MATHESIS_ADJUDICATE" cases.export -- $TARGETS ) \
  > "$TMP/out.json" 2>/dev/null || true

if ! [ -s "$TMP/out.json" ]; then
  echo "FATAL: the gate produced no output"; exit 1
fi

# ---- vacuous behind a name ---------------------------------------------------------------
for t in hiddenOnce hiddenChain hiddenQuantified; do
  r="$(triv out.json "$t")"
  case "$r" in
    ""|null|ABSENT) bad "${t}_is_flagged" "${r:-unreadable}" ;;
    *)              ok  "${t}_is_flagged" ;;
  esac
done

# The reason must say the unfolding happened, or the operator reading it cannot tell a literal
# `True` from one that took three aliases to reach.
case "$(triv out.json hiddenChain)" in
  *unfolding*) ok  "the_reason_says_it_had_to_unfold" ;;
  *)           bad "the_reason_says_it_had_to_unfold" "$(triv out.json hiddenChain)" ;;
esac

# ---- vacuous and obvious: must not have regressed -----------------------------------------
for t in plainTrue plainRefl; do
  r="$(triv out.json "$t")"
  case "$r" in
    ""|null|ABSENT) bad "${t}_is_still_flagged" "${r:-unreadable}" ;;
    *)              ok  "${t}_is_still_flagged" ;;
  esac
done

# ---- honest: must not be flagged ----------------------------------------------------------
# honestArith is the promise in the gate's own documentation. honestTwice puts one of the
# submission's own definitions at the head, so the unfolding path runs and must still say no.
for t in honestArith honestTwice; do
  r="$(triv out.json "$t")"
  case "$r" in
    null) ok  "${t}_is_not_flagged" ;;
    *)    bad "${t}_is_not_flagged" "${r:-unreadable}" ;;
  esac
done

# ---- the statement the kernel checked ------------------------------------------------------
if [ "$(stmt out.json honestTwice)" = "null" ] || [ "$(stmt out.json honestTwice)" = "ABSENT" ]; then
  bad "every_target_carries_the_kernels_statement" "$(stmt out.json honestTwice)"
else
  ok "every_target_carries_the_kernels_statement"
fi

# Rendered in an empty environment, so it names constants in full rather than through whatever
# the author's module made available.
case "$(stmt out.json honestTwice)" in
  *twice*) ok  "the_statement_is_the_targets_own_type" ;;
  *)       bad "the_statement_is_the_targets_own_type" "$(stmt out.json honestTwice)" ;;
esac

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
