#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Upload the frozen export blobs to the `exports-v1` Release on mathesis-bank,
# named by sha256 so ci/fetch_exports.sh can pull them content-addressed.
#
# The blobs are the immutable frozen references. They are PUBLIC + auditable by
# design (anyone can re-run the gate against them), and fit GitHub's 2 GB/asset
# limit. This is a credentialed action — run it as the account with push/release
# rights on noumenal-ai/mathesis-bank.
#
# The blob list is DERIVED from the registry manifests with the same discovery
# logic ci/fetch_exports.sh uses, never hand-maintained: a hardcoded list had
# already drifted, omitting the 129 MB Eidometry blob that 41 accessions
# reference, so the fetch side expected an asset the upload side never pushed.
#
# Usage:
#   MATHESIS_BACKEND=/path/to/Mathesis-v4.31 bash deploy/upload-blobs.sh
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="${MATHESIS_REPO:-noumenal-ai/mathesis-bank}"
TAG="${MATHESIS_EXPORT_TAG:-exports-v1}"
PRIV="${MATHESIS_BACKEND:-/Users/polaris/Documents/Epistemology and Zetesis/Noumenal/Mathesis-v4.31}"
EXPORTS="$PRIV/registry/_shared/exports"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Destination. Mirrors the store forms ci/fetch_exports.sh reads, so the upload and fetch sides
# stay symmetric:
#   gh:owner/repo@tag     GitHub release assets (default; 2 GB/asset ceiling)
#   gs://bucket[/prefix]  Google Cloud Storage
#   s3://bucket[/prefix]  S3 / Cloudflare R2 (via the aws CLI)
#
# Validated HERE, before the blob-existence check: a mistyped destination should fail
# immediately, not after confirming half a gigabyte of local files.
DEST="${MATHESIS_EXPORT_STORE:-gh:$REPO@$TAG}"
case "$DEST" in
  gs://*|s3://*|gh:*) : ;;
  *)
    echo "FATAL: unrecognized MATHESIS_EXPORT_STORE '$DEST'"
    echo "       expected gh:owner/repo@tag, gs://bucket, or s3://bucket"
    exit 1
    ;;
esac
echo "destination: $DEST"

# Every frozen_export sha referenced by ANY bank manifest — results, claims (a
# discharge's reference R lives here), and dictionary. Mirrors the no-args
# branch of ci/fetch_exports.sh so the two sides cannot disagree.
# (while-read, not `mapfile`: this script is run locally and macOS ships bash 3.2.)
blobs=()
while IFS= read -r b; do
  [ -n "$b" ] && blobs+=("$b")
done < <(python3 - "$ROOT" <<'PY'
import json, glob, os, sys
root = sys.argv[1]; s = set()
for bank in ("results", "claims", "dictionary"):
    for p in glob.glob(os.path.join(root, "registry", bank, "*", "manifest.json")):
        fe = (json.load(open(p)).get("frozen_export") or {})
        if fe.get("sha256"):
            s.add(fe["sha256"] + ".export")
print("\n".join(sorted(s)))
PY
)

[ "${#blobs[@]}" -gt 0 ] || { echo "FATAL: no frozen_export sha256s referenced by any manifest — nothing to upload."; exit 1; }

echo "${#blobs[@]} blob(s) referenced by the registry:"
printf '  %s\n' "${blobs[@]}"

missing=0
for b in "${blobs[@]}"; do
  [ -f "$EXPORTS/$b" ] || { echo "FATAL: blob missing: $EXPORTS/$b"; missing=1; }
done
[ "$missing" -eq 0 ] || exit 1

case "$DEST" in
  gs://*)
    command -v gsutil >/dev/null 2>&1 || { echo "FATAL: gsutil not on PATH (install the gcloud SDK)"; exit 1; }
    for b in "${blobs[@]}"; do
      echo "uploading $b ($(du -h "$EXPORTS/$b" | cut -f1)) ..."
      # Content-addressed and immutable: cache hard, and never gzip-transcode a blob whose
      # sha256 the fetcher re-verifies byte-for-byte.
      gsutil -h "Cache-Control:public, max-age=31536000, immutable" \
             cp -n "$EXPORTS/$b" "${DEST%/}/$b"
    done
    echo "Done. Objects under ${DEST%/}:"
    gsutil ls "${DEST%/}/" | sed 's/^/  /'
    ;;

  s3://*)
    command -v aws >/dev/null 2>&1 || { echo "FATAL: aws CLI not on PATH"; exit 1; }
    for b in "${blobs[@]}"; do
      echo "uploading $b ($(du -h "$EXPORTS/$b" | cut -f1)) ..."
      aws s3 cp "$EXPORTS/$b" "${DEST%/}/$b" \
        --cache-control "public, max-age=31536000, immutable"
    done
    echo "Done. Objects under ${DEST%/}:"
    aws s3 ls "${DEST%/}/" | sed 's/^/  /'
    ;;

  gh:*)
    spec="${DEST#gh:}"; tag="${spec##*@}"; repo="${spec%@*}"
    # Create the release if it does not exist yet (idempotent).
    if ! gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
      gh release create "$tag" -R "$repo" \
        --title "Mathesis frozen exports (v1)" \
        --notes "Content-addressed frozen .export blobs (sha256-named). Fetched by ci/fetch_exports.sh and re-derived by mathesis-adjudicate. Immutable references for the founding WMSpec volume."
    fi
    for b in "${blobs[@]}"; do
      echo "uploading $b ($(du -h "$EXPORTS/$b" | cut -f1)) ..."
      gh release upload "$tag" -R "$repo" "$EXPORTS/$b" --clobber
    done
    echo "Done. Assets on $repo@$tag:"
    gh release view "$tag" -R "$repo" --json assets --jq '.assets[].name'
    ;;
esac

echo
echo "Verifiers fetch with:"
case "$DEST" in
  gs://*) echo "  export MATHESIS_EXPORT_STORE=https://storage.googleapis.com/${DEST#gs://}" ;;
  s3://*) echo "  export MATHESIS_EXPORT_STORE=https://<your-cdn-or-bucket-host>/${DEST#s3://}" ;;
  gh:*)   echo "  export MATHESIS_EXPORT_STORE=$DEST" ;;
esac
echo "  bin/mathesis check --all"
