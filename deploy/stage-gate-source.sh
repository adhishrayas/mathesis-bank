#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Stage the re-derivation gate source into mathesis-site/backend-gate/ so the
# PUBLIC verify.yml can build `mathesis-adjudicate` from auditable source.
#
# This vendors ONLY the ~8 Lean files of the gate (Comparator-derived,
# Apache-2.0) + a minimal lakefile — NOT the private backend's internal docs.
# Run it before committing when deploying P0 with option A (see DEPLOY_P0.md).
#
# Usage:  MATHESIS_BACKEND=/path/to/Mathesis-v4.31/backend/lean bash deploy/stage-gate-source.sh
# ---------------------------------------------------------------------------
set -euo pipefail

SRC="${MATHESIS_BACKEND:-/Users/polaris/Documents/Epistemology and Zetesis/Noumenal/Mathesis-v4.31/backend/lean}"
SITE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="$SITE/backend-gate"

[ -f "$SRC/MathesisAdjudicate.lean" ] || { echo "FATAL: gate source not found at $SRC (set MATHESIS_BACKEND)"; exit 1; }

# The trusted logical-core reference (init.export + its anchor + README) was added
# to backend-gate/ AFTER this script was written and is NOT part of the vendored
# set below, so a bare `rm -rf "$DST"` would silently delete the fake-connective
# defense. Preserve the public copies across the wipe; if $SRC carries its own
# (more canonical) copies, the vendor step below overwrites them.
STASH=""
if [ -f "$DST/init.export" ]; then
  STASH="$(mktemp -d)"
  for f in init.export init.export.anchor.lean init.export.README.md; do
    [ -f "$DST/$f" ] && cp "$DST/$f" "$STASH/$f"
  done
fi

rm -rf "$DST"
mkdir -p "$DST/Mathesis/Primitive"

if [ -n "$STASH" ]; then
  for f in init.export init.export.anchor.lean init.export.README.md; do
    [ -f "$STASH/$f" ] && cp "$STASH/$f" "$DST/$f"
  done
  rm -rf "$STASH"
  echo "preserved the trusted init.export reference across the wipe."
fi

# The gate: root + verdict + the two primitives + manifest + orchestrator + the exe root.
cp "$SRC/Mathesis.lean"                       "$DST/Mathesis.lean"
cp "$SRC/Mathesis/Verdict.lean"               "$DST/Mathesis/Verdict.lean"
cp "$SRC/Mathesis/Manifest.lean"              "$DST/Mathesis/Manifest.lean"
cp "$SRC/Mathesis/Adjudicate.lean"            "$DST/Mathesis/Adjudicate.lean"
cp "$SRC/Mathesis/Primitive/CheckProof.lean"  "$DST/Mathesis/Primitive/CheckProof.lean"
cp "$SRC/Mathesis/Primitive/RunWitness.lean"  "$DST/Mathesis/Primitive/RunWitness.lean"
cp "$SRC/MathesisAdjudicate.lean"             "$DST/MathesisAdjudicate.lean"
cp "$SRC/lean-toolchain"                      "$DST/lean-toolchain"

# The trusted reference, when the private backend carries it (it is bank-owned and
# may live only in the public repo — hence the preserve step above).
for f in init.export init.export.anchor.lean init.export.README.md; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DST/$f"
done

# Fail loudly rather than staging a gate that cannot run its redefinition check:
# both production workflows set MATHESIS_INIT_EXPORT to this path, and the gate
# only prints a note (not an error) when the file is absent.
[ -f "$DST/init.export" ] || {
  echo "FATAL: no init.export in $DST after staging."
  echo "  Both workflows point MATHESIS_INIT_EXPORT at it, and the gate DISABLES the"
  echo "  trusted-redefinition check when it is missing. Regenerate it per"
  echo "  backend-gate/init.export.README.md before committing."
  exit 1
}

# Minimal lakefile — the Mathesis lib + the re-derivation exe only. Deliberately
# excludes MathesisSelfTest (internal test fixtures declare a test axiom; not
# part of the shipped verifier). Dep revs pinned to the gate's toolchain.
cat > "$DST/lakefile.lean" <<'LAKE'
import Lake
open Lake DSL

package mathesis where
  leanOptions := #[⟨`autoImplicit, false⟩]

require lean4export from git
  "https://github.com/leanprover/lean4export" @ "ca36c44858e2d7ba40996203d2f08a69113d1211"

require Lean4Checker from git
  "https://github.com/leanprover/lean4checker" @ "b7398199245524275543dec6113229c9bb4902e5"

@[default_target]
lean_lib Mathesis where
  globs := #[Glob.andSubmodules `Mathesis]

/-- The re-derivation gate the public CI runs: `mathesis-adjudicate <export> -- <decls>`,
exit 0 iff replay accepts AND every target's axiom closure ⊆ the hard-coded whitelist.
`@[default_target]` so a bare `lake build` (what lean-action runs) builds the exe, not just the lib. -/
@[default_target]
lean_exe «mathesis-adjudicate» where
  root := `MathesisAdjudicate
  supportInterpreter := true
LAKE

echo "Staged gate source into $DST:"
find "$DST" -type f | sed "s#$DST/#  #"
echo
echo "Next: cd '$SITE' && lake --dir=backend-gate build mathesis-adjudicate   # sanity build"
echo "Then commit backend-gate/ and push (see deploy/DEPLOY_P0.md)."
