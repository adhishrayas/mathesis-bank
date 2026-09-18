#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# Produce the trusted `mathlib.export` reference for a Mathlib environment.
#
#   bash deploy/builder/make-mathlib-export.sh
#   MATHLIB_REV=<40-hex> OUT_DIR=/tmp/ref bash deploy/builder/make-mathlib-export.sh
#
# WHAT THIS PRODUCES AND WHY IT MUST EXIST BEFORE MATHLIB OPENS
# -------------------------------------------------------------
# `init.export` protects 59 constants of Lean's logical core and says nothing about Mathlib
# names. The moment Mathlib is importable, a deposit with no `@discharges` takes the self-audit
# path — no reference environment, so no statement-identity leg — and could ship its own `Real`
# and prove something true of its own definition that reads to a human as a Mathlib theorem.
# Axioms clean, replay fine.
#
# The pinned `mathlib.export` closes that: `CheckProof.trustedMatches` compares every reached
# constant that ALSO exists in the reference, so coverage of the reference is exactly the set of
# constants a deposit cannot redefine. `environments_active_mathlib_needs_reference` refuses to
# make a Mathlib revision pinnable until its sha256 is recorded, so this script is what unblocks
# that activation rather than an optional extra.
#
# WHOLE-ENVIRONMENT EXPORT, NOT AN ANCHOR
# ---------------------------------------
# `init.export` was produced through a single anchor declaration
# (`backend-gate/init.export.anchor.lean`) because the multi-declaration `Init` export panicked
# in this lean4export. That technique does not scale: no one theorem's closure reaches all of
# Mathlib.
#
# lean4export's `Main.lean` at the pinned revision takes `lean4export <module...> [-- <decl...>]`
# and, with **no `--` separator**, dumps every non-internal constant in the environment:
#
#     let constants := match constants.tail? with
#       | some cs => ...
#       | none    => env.constants.toList.map Prod.fst |>.filter (!·.isInternal)
#
# which looks like exactly what a reference wants to be. Measured on this revision, it is not:
#
#     whole Mathlib environment   >= 2.77 GB emitted, then NO further output for 35 minutes at
#                                    ~5 GB RSS; killed at 62 minutes, never completed
#     51 curated constants          45.6 MB, 12,683 constants, 11.5 s
#     6 curated constants           13.9 MB,  4,603 constants,  8.5 s
#     one theorem's proof closure   40.6 MB, 11,155 constants, 48.7 s
#     init.export, for scale        49.5 KB,      59 constants
#
# Even had it completed, the adjudicator parses the reference with `loadFrozenText` on EVERY
# adjudication, and a multi-GB parse per deposit is not viable. So the reference is the closure
# of a curated vocabulary — the names a claim is STATED in — listed in `mathlib-reference.decls`,
# which records the selection principle and, importantly, what it does NOT cover.
#
# The multi-declaration panic that forced init.export through a single anchor declaration does
# not occur here: the pinned lean4export resets `noMDataExprs` per constant. This script does not
# take that on trust — it treats any panic on stderr as fatal, exactly as `gate_deposit.sh` does,
# because lean4export can panic and still exit 0.
#
# THE EXPORTER IS NOT THE DEPOSIT BUILDER
# ---------------------------------------
# This runs the `exporter` stage, which carries lean4export and is never handed to a deposit.
# There are three images in play, and keeping them straight matters:
#
#   exporter    (this script only)  toolchain + Mathlib source + cache + lean4export
#   exportrt    environments.export_image   builder + lean4export; runs the gate's export step
#   builder     environments.builder_image  toolchain + oleans only; runs UNTRUSTED deposit code
#
# The builder carries no lean4export and no adjudicator, asserted at the end of this script.
# ---------------------------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${PYTHON:-python3}"

LEAN_VERSION="${LEAN_VERSION:-v4.31.0}"
MATHLIB_REV="${MATHLIB_REV:-fabf563a7c95a166b8d7b6efca11c8b4dc9d911f}"
MODULE="${MODULE:-Mathlib}"
# The runner and Cloud Run are amd64. Nothing pinned a platform before, so a build on an Apple
# Silicon Mac produced arm64 images that die on CI with `exec format error` — which surfaces
# through gate_deposit.sh as "reject — submission.lean failed to build", blaming a depositor
# whose proof was fine. Pin it, and let a genuinely arm64 host opt out explicitly.
PLATFORM="${PLATFORM:-linux/amd64}"
OUT_DIR="${OUT_DIR:-$ROOT/build/reference}"
DECLS_FILE="${DECLS_FILE:-$ROOT/deploy/builder/mathlib-reference.decls}"

SHORT="${MATHLIB_REV:0:7}"
EXPORTER_TAG="mathesis/lean-exporter:${LEAN_VERSION}-mathlib-${SHORT}"
BUILDER_TAG="mathesis/lean-builder:${LEAN_VERSION}-mathlib-${SHORT}"
EXPORTRT_TAG="mathesis/lean-exporter-rt:${LEAN_VERSION}-mathlib-${SHORT}"

case "$MATHLIB_REV" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
  *) echo "FATAL: MATHLIB_REV must be a 40-char git sha, got '$MATHLIB_REV'"; exit 2 ;;
esac
[ "${#MATHLIB_REV}" -eq 40 ] || { echo "FATAL: MATHLIB_REV must be 40 chars"; exit 2; }

mkdir -p "$OUT_DIR"
command -v docker >/dev/null 2>&1 || { echo "FATAL: docker required"; exit 2; }

echo "mathlib reference"
echo "  toolchain   leanprover/lean4:$LEAN_VERSION"
echo "  mathlib     $MATHLIB_REV"
echo "  module      $MODULE"
echo "  out         $OUT_DIR"
echo

# ── 1. the exporter image ────────────────────────────────────────────────────────────────────
# Skip if the tag already exists. `lake exe cache get` downloads 8542 files, and BuildKit does
# not always reuse that layer across invocations — a rerun of this script should not pay for it
# again. The tag encodes the toolchain and the Mathlib revision, so an existing tag is the right
# image by construction; set REBUILD=1 to force.
if [ -z "${REBUILD:-}" ] && docker image inspect "$EXPORTER_TAG" >/dev/null 2>&1; then
  echo "  reusing $EXPORTER_TAG (REBUILD=1 to force)"
else
  echo "building the exporter stage (downloads Mathlib's olean cache; slow) ..."
  if ! docker build --progress=plain --platform "$PLATFORM" \
        -f "$ROOT/deploy/builder/Dockerfile.mathlib" --target exporter \
        --build-arg "LEAN_VERSION=$LEAN_VERSION" \
        --build-arg "MATHLIB_REV=$MATHLIB_REV" \
        -t "$EXPORTER_TAG" "$ROOT/deploy/builder" >"$OUT_DIR/exporter-build.log" 2>&1; then
    echo "FATAL: exporter image build failed; see $OUT_DIR/exporter-build.log"
    tail -30 "$OUT_DIR/exporter-build.log" | sed 's/^/    /'
    exit 1
  fi
  echo "  ok  $EXPORTER_TAG"
fi

# ── 2. export the whole environment ──────────────────────────────────────────────────────────
# No --network none here: this is the TRUSTED side and nothing untrusted runs in it. The
# confinement flags exist for the deposit build, not for the bank's own exporter.
EXPORT="$OUT_DIR/mathlib.export"
ERRLOG="$OUT_DIR/mathlib.export.err"

[ -r "$DECLS_FILE" ] || { echo "FATAL: no reference vocabulary at $DECLS_FILE"; exit 2; }
DECLS="$(sed 's/#.*//' "$DECLS_FILE" | tr -s '[:space:]' '\n' | sed '/^$/d' | tr '\n' ' ')"
[ -n "$DECLS" ] || { echo "FATAL: $DECLS_FILE lists no constants"; exit 2; }
NDECLS="$(printf '%s\n' $DECLS | wc -l | tr -d ' ')"

echo "exporting the closure of $NDECLS constants from $MODULE ..."
if ! docker run --rm \
      -v "$OUT_DIR":/out \
      -e "MODULE=$MODULE" \
      -e "DECLS=$DECLS" \
      --entrypoint sh "$EXPORTER_TAG" -c '
        set -eu
        BIN="$(cat /l4e/.binpath)"
        # $DECLS is deliberately unquoted: each constant must arrive as its own argv item.
        # The vocabulary file is bank-controlled and its contents are whitespace-separated
        # identifiers, not deposit input.
        LEAN_PATH=/oleans "$BIN" "$MODULE" -- $DECLS \
          > /out/mathlib.export 2> /out/mathlib.export.err
      '; then
  echo "FATAL: lean4export failed"
  [ -s "$ERRLOG" ] && tail -30 "$ERRLOG" | sed 's/^/    /'
  echo "  a constant named in $DECLS_FILE may not exist at mathlib ${SHORT}"
  exit 1
fi

# lean4export can PANIC yet exit 0, leaving a truncated export. The gate treats that as fatal
# (gate_deposit.sh rejects on panic "regardless of exit code"); a REFERENCE must be held to at
# least the same bar, since a truncated reference silently protects fewer constants.
if [ -s "$ERRLOG" ] && grep -Eiq 'panic|internal error|stack overflow|out of memory' "$ERRLOG"; then
  echo "FATAL: lean4export reported a panic/error despite exiting 0:"
  tail -30 "$ERRLOG" | sed 's/^/    /'
  echo "  refusing to treat a possibly-truncated export as a trusted reference"
  exit 1
fi
[ -s "$EXPORT" ] || { echo "FATAL: export is empty"; exit 1; }

# ── 3. measure it ────────────────────────────────────────────────────────────────────────────
echo
echo "measured:"
"$PY" "$ROOT/ci/export_stats.py" "$EXPORT" || exit 1
SHA="$("$PY" -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$EXPORT")"

# Content-addressed name, which is how fetch_exports.sh and the runner resolve it.
cp "$EXPORT" "$OUT_DIR/$SHA.export"

# ── 4. the runtime builder image, and the assertion that it is NOT the exporter ──────────────
echo
build_stage() {  # build_stage <target-or-empty> <tag> <logname>
  local target="$1" tag="$2" logname="$3"
  if [ -z "${REBUILD:-}" ] && docker image inspect "$tag" >/dev/null 2>&1; then
    echo "  reusing $tag"; return 0
  fi
  local args=(--progress=plain --platform "$PLATFORM"
              -f "$ROOT/deploy/builder/Dockerfile.mathlib"
              --build-arg "LEAN_VERSION=$LEAN_VERSION"
              --build-arg "MATHLIB_REV=$MATHLIB_REV" -t "$tag")
  [ -n "$target" ] && args+=(--target "$target")
  if ! docker build "${args[@]}" "$ROOT/deploy/builder" >"$OUT_DIR/$logname" 2>&1; then
    echo "FATAL: $tag build failed; see $OUT_DIR/$logname"
    tail -30 "$OUT_DIR/$logname" | sed 's/^/    /'
    return 1
  fi
  echo "  ok  $tag"
}

echo "building the two runtime images ..."
# The deposit builder first, then the export runtime FROM it — by tag, not as a sibling stage.
# The two differ by one 246 MB binary and must share every layer beneath it. As sibling stages
# built by two separate `docker build` calls they did NOT: measured 12.2 + 12.5 GB with only
# 2.04 GB shared, i.e. 22.7 GB resident against ~14 GB of runner disk. Building the second FROM
# the first makes the shared base structural rather than a cache outcome.
build_stage "" "$BUILDER_TAG" builder-build.log || exit 1

# Dockerfile.exportrt COPYs the lean4export binary out of the exporter image and into the
# builder image. If those two are different architectures the copied binary is silently broken —
# it would pass the `ldd` guard on some hosts and then fail at run time as a gate error blamed on
# a depositor. Refuse rather than produce that.
B_ARCH="$(docker image inspect "$BUILDER_TAG" --format '{{.Architecture}}' 2>/dev/null)"
E_ARCH="$(docker image inspect "$EXPORTER_TAG" --format '{{.Architecture}}' 2>/dev/null)"
if [ -n "$B_ARCH" ] && [ -n "$E_ARCH" ] && [ "$B_ARCH" != "$E_ARCH" ]; then
  echo "FATAL: builder is $B_ARCH but exporter is $E_ARCH."
  echo "       The export runtime copies lean4export from the exporter into the builder, so the"
  echo "       two must match. Rebuild both with the same PLATFORM (REBUILD=1)."
  exit 1
fi

if [ -n "${REBUILD:-}" ] || ! docker image inspect "$EXPORTRT_TAG" >/dev/null 2>&1; then
  if ! docker build --progress=plain --platform "$PLATFORM" \
        -f "$ROOT/deploy/builder/Dockerfile.exportrt" \
        --build-arg "BUILDER_IMAGE=$BUILDER_TAG" \
        --build-arg "EXPORTER_IMAGE=$EXPORTER_TAG" \
        -t "$EXPORTRT_TAG" "$ROOT/deploy/builder" >"$OUT_DIR/exportrt-build.log" 2>&1; then
    echo "FATAL: $EXPORTRT_TAG build failed; see $OUT_DIR/exportrt-build.log"
    tail -30 "$OUT_DIR/exportrt-build.log" | sed 's/^/    /'
    exit 1
  fi
  echo "  ok  $EXPORTRT_TAG"
else
  echo "  reusing $EXPORTRT_TAG"
fi

echo
echo "the DEPOSIT BUILDER must not carry the tools that made the reference:"
rc=0
for t in lean4export mathesis-adjudicate curl git; do
  if docker run --rm --entrypoint sh "$BUILDER_TAG" -c "command -v $t >/dev/null 2>&1"; then
    echo "    FAIL  $t is PRESENT in the deposit builder image"; rc=1
  else
    echo "    ok    $t absent"
  fi
done
if ! docker run --rm --entrypoint sh "$BUILDER_TAG" -c 'test -f /oleans/Mathlib.olean'; then
  echo "    FAIL  Mathlib.olean missing from the builder image"; rc=1
else
  echo "    ok    Mathlib.olean present"
fi

echo "the EXPORT RUNTIME must carry lean4export and still no adjudicator:"
if docker run --rm --entrypoint sh "$EXPORTRT_TAG" -c 'command -v lean4export >/dev/null 2>&1'; then
  echo "    ok    lean4export present"
else
  echo "    FAIL  lean4export absent — the gate's export step would fail on every deposit"; rc=1
fi
for t in mathesis-adjudicate curl git; do
  if docker run --rm --entrypoint sh "$EXPORTRT_TAG" -c "command -v $t >/dev/null 2>&1"; then
    echo "    FAIL  $t is PRESENT in the export image"; rc=1
  else
    echo "    ok    $t absent"
  fi
done
# The functional check the ldd guard in the Dockerfile cannot make: that the copied binary
# actually runs against this image's toolchain and resolves Mathlib.
if docker run --rm --entrypoint sh "$EXPORTRT_TAG" -c \
     'lean4export Mathlib -- Real > /dev/null 2>&1'; then
  echo "    ok    lean4export resolves Mathlib in the export image"
else
  echo "    FAIL  lean4export cannot resolve Mathlib in the export image"; rc=1
fi
# The two images must SHARE one base, not merely be similar. This is the assertion the old
# sibling-stage layout would have failed silently: 12.2 and 12.5 GB with only 2.04 GB in common,
# so both resident cost 22.7 GB against ~14 GB of runner disk, and nothing measured it. A size
# check is too weak — identical sizes with DIFFERENT digests is exactly the failure mode. The
# builder's layer list must be a strict PREFIX of the export image's.
echo "the two images must share one base, not duplicate it:"
b_layers="$(docker image inspect "$BUILDER_TAG"  --format '{{range .RootFS.Layers}}{{.}}
{{end}}' | sed '/^$/d')"
e_layers="$(docker image inspect "$EXPORTRT_TAG" --format '{{range .RootFS.Layers}}{{.}}
{{end}}' | sed '/^$/d')"
nb="$(printf '%s\n' "$b_layers" | wc -l | tr -d ' ')"
ne="$(printf '%s\n' "$e_layers" | wc -l | tr -d ' ')"
if [ "$(printf '%s\n' "$e_layers" | head -n "$nb")" = "$b_layers" ]; then
  echo "    ok    export image extends the builder ($nb shared layers, $((ne - nb)) added)"
else
  ncommon="$(comm -12 <(printf '%s\n' "$b_layers" | sort) <(printf '%s\n' "$e_layers" | sort) \
             | wc -l | tr -d ' ')"
  echo "    FAIL  the images do not share a base — both would be pulled and stored in full"
  echo "          builder $nb layers, export $ne layers, only $ncommon in common"
  rc=1
fi

[ "$rc" -eq 0 ] || { echo "  refusing to report success with a broken image pair"; exit 1; }

# ── 5. what to do with it ────────────────────────────────────────────────────────────────────
cat <<NEXT

reference ready
  $OUT_DIR/$SHA.export

next, in order — the schema enforces this ordering, so none of it is optional:

  1. upload the blob to the export store, content-addressed as $SHA.export
  2. push BOTH images to the registry the runner pulls from:
       $BUILDER_TAG
       $EXPORTRT_TAG
  3. create + activate the environment (activation is REFUSED without the reference AND
     without the export image):

       python3 backend/environments.py --db "\$MATHESIS_WRITE_DB" --create \\
         --toolchain leanprover/lean4:$LEAN_VERSION \\
         --mathlib $MATHLIB_REV \\
         --image $BUILDER_TAG \\
         --export-image $EXPORTRT_TAG
       python3 backend/environments.py --db "\$MATHESIS_WRITE_DB" --activate <id> \\
         --init-reference \$(shasum -a 256 backend-gate/init.export | cut -d' ' -f1) \\
         --mathlib-reference $SHA

  note: init.export is 50 KB and lives in git, NOT in the export store. The runner resolves a
  reference by content address and will satisfy it from the checkout, so it does not need
  uploading — see "Resolving the reference" in backend/README.md.
NEXT
