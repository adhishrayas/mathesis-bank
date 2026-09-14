#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Prove the containerized deposit build is actually confined.
#
#   bash ci/test_gate_isolation.sh
#
# WHY THIS TEST EXISTS
# --------------------
# The gate's security argument is "a hostile build cannot forge an admission, because the
# trusted kernel replays the export". That holds only if the build cannot reach the verifier.
# Before this, it could: the build ran with cwd inside the checkout and ordinary write access
# to it, and the checkout holds the adjudicator binary, `init.export`, the exports dir, and the
# claim manifest whose sha256 the gate re-verifies.
#
# The old `landrun` path was meant to confine it and never ran — nothing installs landrun, so
# control always fell to the bare branch.
#
# Lean elaboration is arbitrary code execution by design (`#eval`, `initialize`, elaboration
# macros), so this test stands in a HOSTILE `lean` that attempts the things a malicious
# submission would, and asserts each one is denied. It needs no Lean toolchain: the point is
# the sandbox, not the compiler.
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
IMAGE="mathesis-gate-isolation-probe:test"
pass=0; fail=0

cleanup() { rm -rf "$TMP"; docker rmi -f "$IMAGE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

check() {  # check <name> <condition-cmd...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  PASS  %s\n' "$name"; pass=$((pass+1))
  else
    printf '  FAIL  %s\n' "$name"; fail=$((fail+1))
  fi
}

command -v docker >/dev/null 2>&1 || { echo "SKIPPED — docker not available"; exit 0; }
docker info >/dev/null 2>&1 || { echo "SKIPPED — docker daemon not reachable"; exit 0; }

echo "gate build isolation"
echo

# ---- a hostile stand-in for `lean` ----------------------------------------
# Each probe writes one line to /work/probe.txt. The build then "succeeds" so the gate script
# proceeds normally; we only care what the probes found.
mkdir -p "$TMP/img"
cat > "$TMP/img/lean" <<'PROBE'
#!/bin/sh
# Stand-in for a hostile `lean`: attempt what a malicious elaboration would, then satisfy the
# caller so the gate proceeds.
P=/work/probe.txt
: > "$P"

echo "cwd=$(pwd)" >> "$P"

# 1. Can we reach the network? (egress denial)
if wget -q -T 3 -O /dev/null http://neverssl.com 2>/dev/null; then
  echo "http=REACHED" >> "$P"; else echo "http=denied" >> "$P"; fi
if nslookup github.com >/dev/null 2>&1; then
  echo "dns=RESOLVED" >> "$P"; else echo "dns=denied" >> "$P"; fi

# 2. Is the repo checkout reachable? Its presence would expose the adjudicator binary,
#    init.export, the exports dir and the claim manifests.
for probe in /app/backend/admission.py /app/backend-gate/init.export \
             /repo/backend-gate/init.export /workspace/backend-gate/init.export; do
  [ -e "$probe" ] && echo "checkout=REACHABLE:$probe" >> "$P"
done
grep -qs . /proc/1/environ 2>/dev/null && true
if find / -maxdepth 3 -name 'init.export' 2>/dev/null | grep -q .; then
  echo "init_export=FOUND" >> "$P"; else echo "init_export=absent" >> "$P"; fi
if find / -maxdepth 3 -name 'mathesis-adjudicate' 2>/dev/null | grep -q .; then
  echo "adjudicator=FOUND" >> "$P"; else echo "adjudicator=absent" >> "$P"; fi

# 3. Is the environment inherited? GH_TOKEN was previously in scope during elaboration.
if [ -n "${GH_TOKEN:-}" ]; then echo "gh_token=PRESENT" >> "$P"; else echo "gh_token=absent" >> "$P"; fi
if [ -n "${MATHESIS_ADJUDICATE:-}" ]; then echo "adj_env=PRESENT" >> "$P"; else echo "adj_env=absent" >> "$P"; fi
echo "env_count=$(env | wc -l | tr -d ' ')" >> "$P"

# 4. Can we write outside the scratch mount?
if echo x > /etc/mathesis-probe 2>/dev/null; then
  echo "write_etc=ALLOWED" >> "$P"; else echo "write_etc=denied" >> "$P"; fi
if echo x > /work/writable 2>/dev/null; then
  echo "write_work=allowed" >> "$P"; else echo "write_work=DENIED" >> "$P"; fi

# Satisfy the caller: produce the requested output file.
out=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2;; *) shift;; esac
done
[ -n "$out" ] && echo "stub olean" > "$out"
exit 0
PROBE
chmod +x "$TMP/img/lean"

cat > "$TMP/img/Dockerfile" <<'DOCKER'
FROM alpine:3.20
COPY lean /usr/local/bin/lean
RUN chmod +x /usr/local/bin/lean
DOCKER

docker build -q -t "$IMAGE" "$TMP/img" >/dev/null 2>&1 \
  || { echo "  FAIL  could not build the probe image"; exit 1; }

# ---- run the real gate script with the probe image ------------------------
DEP="$TMP/deposits/probe"
mkdir -p "$DEP"
cat > "$DEP/submission.lean" <<'SUB'
/-!
# Mathesis deposit

@kind: result
@title: isolation probe
@module: Submission
@decls: probe_identity
@pin: leanprover/lean4:v4.31.0

@gloss:
  A probe used by ci/test_gate_isolation.sh.
-/

theorem probe_identity (n : Nat) : n = n := rfl
SUB

OUT="$TMP/out"
# A fake adjudicator: the gate requires MATHESIS_ADJUDICATE to exist, and this test is about
# the build's confinement rather than adjudication.
cat > "$TMP/fake-adjudicate" <<'FAKE'
#!/bin/sh
echo '{"verdict":"REJECTED","targets":[],"replay":{"accepted":false,"detail":"probe"}}'
exit 1
FAKE
chmod +x "$TMP/fake-adjudicate"

MATHESIS_BUILDER_IMAGE="$IMAGE" \
MATHESIS_ADJUDICATE="$TMP/fake-adjudicate" \
MATHESIS_LEAN4EXPORT="/bin/false" \
MATHESIS_OUT_DIR="$OUT" \
GH_TOKEN="ghp_thisMustNotBeVisibleToTheBuild" \
  bash "$ROOT/ci/gate_deposit.sh" "$DEP" >"$TMP/gate.out" 2>"$TMP/gate.err"

# The gate deletes its scratch dir on exit, and the probe writes into that mount — so capture
# the probe output by running the SAME container invocation against a persistent directory.
# The flags below are copied from `gate_deposit.sh`; if they drift, this test stops testing the
# real sandbox, which is why the gate's own output is asserted separately below.
WORKP="$TMP/probe-work"
mkdir -p "$WORKP"
cp "$DEP/submission.lean" "$WORKP/Submission.lean"
docker run --rm --network none --read-only --tmpfs /tmp \
  -v "$WORKP":/work --memory 2g --cpus 1 --pids-limit 256 \
  -e HOME=/work -w /work "$IMAGE" \
  timeout 60 lean --root=/work -o /work/Submission.olean /work/Submission.lean \
  >/dev/null 2>&1
PROBE_FILE="$WORKP/probe.txt"

if [ ! -s "$PROBE_FILE" ]; then
  echo "  FAIL  the probe produced no output"
  exit 1
fi

echo "  probe results:"
sed 's/^/    /' "$PROBE_FILE"
echo

has() { grep -q "^$1$" "$PROBE_FILE"; }

# ---- the assertions -------------------------------------------------------
check "network egress denied (http)"          has "http=denied"
check "dns resolution denied"                 has "dns=denied"
check "repo checkout not reachable"           bash -c "! grep -q 'checkout=REACHABLE' '$PROBE_FILE'"
check "init.export not reachable"             has "init_export=absent"
check "adjudicator binary not reachable"      has "adjudicator=absent"
check "GH_TOKEN not in the build environment" has "gh_token=absent"
check "gate env vars not inherited"           has "adj_env=absent"
check "cannot write outside the scratch mount" has "write_etc=denied"
check "scratch mount is writable"             has "write_work=allowed"
check "cwd is the scratch dir, not the repo"  has "cwd=/work"

# ---- and the gate reported the containerized path, not the bare one -------
check "gate used the containerized build" grep -q "containerized build" "$TMP/gate.out"
check "gate did not fall back to BARE"    bash -c "! grep -q 'build runs BARE' '$TMP/gate.out'"

# ---- artifacts are kept, not deleted -------------------------------------
check "report was persisted to MATHESIS_OUT_DIR" test -s "$OUT/report.md"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
