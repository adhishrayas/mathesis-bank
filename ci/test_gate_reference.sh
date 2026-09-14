#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# The gate must not trust a verdict reached with an inactive trusted reference.
#
#   bash ci/test_gate_reference.sh
#
# WHAT THIS PROTECTS
# ------------------
# `MATHESIS_INIT_EXPORT` names the bank-owned reference that `mathesis-adjudicate` compares every
# reached constant against. Unset, the exe says so and carries on with the check disabled — that
# is documented and deliberate. But a file that is present and EMPTY loads as zero constants, and
# the exe carries on just the same, announcing "loaded: 0 constants" and admitting.
#
# Measured against the real adjudicator and a real spoofing candidate (a deposit defining its own
# `Real := Unit` and proving "every two reals are equal" — kernel-valid, axioms clean, and it
# reads to a human as a claim about the reals):
#
#   MATHESIS_INIT_EXPORT=mathlib.export  -> "loaded: 12683 constants"  exit 1  REJECTED
#   MATHESIS_INIT_EXPORT=<empty file>    -> "loaded: 0 constants"      exit 0  ADMITTED
#   MATHESIS_INIT_EXPORT=<garbage>       -> loader throws              exit 1  (fails closed)
#   MATHESIS_INIT_EXPORT unset           -> check DISABLED             exit 0  ADMITTED
#
# The middle row is the whole point of this file. A zero-byte reference is reachable from an
# interrupted download, a half-written upload, or a fetch that left an empty file behind, and it
# turns the defence off while still looking configured. `ci/run_deposit_job.sh` already refuses an
# empty or hash-mismatched reference, but the gate must not depend on its caller for that.
#
# Stub binaries throughout: what is under test is the gate's REFUSAL LOGIC, not the kernel. The
# real adjudicator is exercised by ci/verify.sh, and the four rows above were measured directly.
# ---------------------------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

check() { # check <name> <cond-cmd...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then printf '  PASS  %s\n' "$name"; pass=$((pass+1))
  else printf '  FAIL  %s\n' "$name"; fail=$((fail+1)); fi
}

echo "gate trusted-reference handling"
echo

BIN="$TMP/bin"; mkdir -p "$BIN" "$TMP/dep" "$TMP/out"
cat > "$BIN/lean" <<'EOF'
#!/bin/sh
out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done
[ -n "$out" ] && echo olean > "$out"
exit 0
EOF
cat > "$BIN/lean4export" <<'EOF'
#!/bin/sh
echo "CANDIDATE EXPORT"
exit 0
EOF
# Admits, and mirrors the real exe's stderr line. STUB_CONSTANTS controls the reported count so
# the "loaded nothing" case can be reproduced without depending on a real export file.
cat > "$BIN/adjudicate" <<'EOF'
#!/bin/sh
if [ -n "${MATHESIS_INIT_EXPORT:-}" ]; then
  echo "trusted init.export loaded: ${STUB_CONSTANTS:-59} constants" >&2
else
  echo "note: MATHESIS_INIT_EXPORT not set; trusted-redefinition check DISABLED" >&2
fi
cat <<JSON
{"replay":{"accepted":true,"detail":"ok"},"constants":1,"permitted":["propext"],
 "statement_identity":"not-applicable",
 "targets":[{"decl":"probe_ref","kind":"theorem","axiom_audit":"pass","illegal_axiom":null,
             "axioms_reached":[],"triviality":null}],"verdict":"ADMITTED"}
JSON
exit 0
EOF
chmod +x "$BIN"/*

cat > "$TMP/dep/submission.lean" <<'EOF'
/-!
# Mathesis deposit

@kind: result
@title: a reference-handling probe
@module: Submission
@decls: probe_ref
@pin: leanprover/lean4:v4.31.0

@gloss:
  Exists only to drive the gate.
-/

theorem probe_ref (n : Nat) : n = n := rfl
EOF

: > "$TMP/empty.export"
printf 'not-empty-but-loads-nothing\n' > "$TMP/present.export"

run_gate() { # run_gate <init-export-or-empty> <stub-constants>
  rm -rf "$TMP/out"; mkdir -p "$TMP/out"
  env MATHESIS_ADJUDICATE="$BIN/adjudicate" \
      MATHESIS_LEAN4EXPORT="$BIN/lean4export" \
      MATHESIS_OUT_DIR="$TMP/out" \
      STUB_CONSTANTS="$2" \
      PATH="$BIN:$PATH" \
      ${1:+MATHESIS_INIT_EXPORT="$1"} \
      bash "$ROOT/ci/gate_deposit.sh" "$TMP/dep" >"$TMP/report.md" 2>"$TMP/err"
  echo $?
}

# ---- 1. an empty reference is refused before anything is adjudicated -------------------------
RC="$(run_gate "$TMP/empty.export" 59)"
check "empty reference rejects the deposit"        test "$RC" = "2"
check "the report says why"                        grep -q "set but empty" "$TMP/report.md"
check "it never reached a verdict"                 bash -c "! grep -q 'ADMITTED' '$TMP/report.md'"

# ---- 2. present but loading nothing is refused too -------------------------------------------
# The file-level check above cannot catch this: the reference exists and is non-empty, and only
# the exe knows it parsed to an empty environment.
RC="$(run_gate "$TMP/present.export" 0)"
check "a reference loading 0 constants rejects"    test "$RC" = "2"
check "the report names the zero load"             grep -q "0 constants" "$TMP/report.md"

# ---- 3. no false positive on a healthy reference ---------------------------------------------
# The guard must not reject a normal run, or it would block every deposit.
RC="$(run_gate "$TMP/present.export" 12683)"
check "a healthy reference still admits"           test "$RC" = "0"
check "the deposit really was admitted"            grep -q "admit" "$TMP/report.md"

# ---- 4. unset stays as documented ------------------------------------------------------------
# Deliberately unchanged: the exe reports the check is disabled and the gate proceeds. Tightening
# this would break every Lean-core deployment that has no reference configured.
RC="$(run_gate "" 59)"
check "unset reference behaves as before"          test "$RC" = "0"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
