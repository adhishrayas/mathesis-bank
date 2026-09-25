#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# The gate must reject a candidate that redefines a kernel built-in, and still admit honest ones.
#
#   MATHESIS_ADJUDICATE=<gate exe> LEAN4EXPORT=<lean4export exe> bash ci/test_gate_builtins.sh
#
# WHAT THIS PROTECTS
# ------------------
# The kernel handles some constants by name (`CheckProof.kernelBuiltins`) and trusts whatever
# declaration of that name the candidate carries. Before the kernel built-ins leg, the real
# adjudicator, with the trusted init.export loaded, measured:
#
#   GcdCand   (prelude, redefines Nat.gcd, proves 2 + 2 = 5)          ADMITTED
#   CharCand  (prelude, Char.ofNat returns Box, proves False)         ADMITTED
#   HoleCand  (a target reached from another target's statement)      REJECTED
#
# The first two are false theorems admitted; the third is an honest proof refused. Deposits could
# not reach the first two (ci/parse_deposit.py admits no `prelude` line), so nothing banked is
# affected, but the gate must not rest on the parser.
#
# Real binaries and real fixtures (ci/fixtures/gate-builtins, Init only, no Mathlib): what is
# under test is the gate's verdict on candidates the kernel itself accepts.
# ---------------------------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${MATHESIS_ADJUDICATE:?the gate binary}" "${LEAN4EXPORT:?the lean4export binary}"
TRUSTED="$ROOT/backend-gate/init.export"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

check() { # check <name> <cond-cmd...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then printf '  PASS  %s\n' "$name"; pass=$((pass+1))
  else printf '  FAIL  %s\n' "$name"; fail=$((fail+1)); fi
}

# field <verdict.json> <key> — one top-level field of the gate's JSON line (files live in $TMP)
field() { python3 -c 'import json,sys; print(json.loads(open(sys.argv[1]).read().splitlines()[-1])[sys.argv[2]])' "$TMP/$1" "$2"; }
is()       { [ "$(field "$1" "$2")" = "$3" ]; }
mentions() { field "$1" "$2" | grep -qF -- "$3"; }

echo "gate kernel built-ins"
echo

cp -R "$ROOT/ci/fixtures/gate-builtins/." "$TMP/"
cp "$ROOT/backend-gate/lean-toolchain" "$TMP/"
( cd "$TMP" && lake build GcdRef GcdCand CharRef CharCand Honest HoleRef HoleCand ) > "$TMP/build.log" 2>&1 \
  || { echo "FATAL: fixtures failed to build"; tail -20 "$TMP/build.log"; exit 1; }

export_() { # export_ <module> <out> <decls...>
  local mod="$1" out="$2"; shift 2
  ( cd "$TMP" && lake env "$LEAN4EXPORT" "$mod" -- "$@" ) > "$TMP/$out" 2> "$TMP/$out.err" \
    || { echo "FATAL: export of $mod failed"; tail -5 "$TMP/$out.err"; exit 1; }
}
export_ GcdRef   gcd-ref.export   t
export_ GcdCand  gcd-cand.export  t
export_ CharRef  char-ref.export  boom
export_ CharCand char-cand.export boom
export_ Honest   honest.export    Honest.all
export_ HoleRef  hole-ref.export  hex hw
export_ HoleCand hole-cand.export hex hw

gate() { # gate <out.json> <args...>
  local out="$1"; shift
  ( cd "$TMP" && MATHESIS_INIT_EXPORT="$TRUSTED" "$MATHESIS_ADJUDICATE" "$@" ) > "$TMP/$out" 2>/dev/null || true
}
gate gcd-ref.json    --reference gcd-ref.export gcd-cand.export -- t
gate gcd-self.json   gcd-cand.export -- t
gate char.json       --reference char-ref.export char-cand.export -- boom
gate honest.json     honest.export -- Honest.all
gate hole.json       --reference hole-ref.export hole-cand.export -- hex hw
( cd "$TMP" && env -u MATHESIS_INIT_EXPORT "$MATHESIS_ADJUDICATE" honest.export -- Honest.all ) \
  > "$TMP/untrusted.json" 2>/dev/null || true

check "Nat.gcd redefinition (2 + 2 = 5), reference mode: REJECTED"      is gcd-ref.json verdict REJECTED
check "  ... by the kernel built-ins leg, naming Nat.gcd"              mentions gcd-ref.json kernel_builtins "'Nat.gcd'"
check "Nat.gcd redefinition, self-seeded mode (verify-bank.sh): REJECTED" is gcd-self.json verdict REJECTED
check "  ... by the kernel built-ins leg, naming Nat.gcd"              mentions gcd-self.json kernel_builtins "'Nat.gcd'"
check "Char.ofNat returning Box (False): REJECTED"                      is char.json verdict REJECTED
check "  ... by the kernel built-ins leg, naming Char.ofNat"           mentions char.json kernel_builtins "'Char.ofNat'"
check "honest proof through the built-ins: ADMITTED"                    is honest.json verdict ADMITTED
check "  ... with the built-ins leg passing"                            is honest.json kernel_builtins pass
check "target reached from another target's statement: ADMITTED"       is hole.json verdict ADMITTED
check "  ... statement identity passing"                                is hole.json statement_identity pass
check "no trusted init.export: built-ins reported not-checked"          is untrusted.json kernel_builtins not-checked

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
