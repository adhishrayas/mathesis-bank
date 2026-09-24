#!/usr/bin/env bash
# Rebuild the published record from the committed bank: the generator, the
# client assets, the checks, and the rendered tree in docs/.
#   bank/tools/build-site.sh [--site-base URL] [--base-path /p]
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
site_base="https://noumenal-ai.github.io/mathesis-bank"
base_path="/mathesis-bank"
while [ $# -gt 0 ]; do
  case "$1" in
    --site-base) site_base="$2"; shift 2 ;;
    --base-path) base_path="$2"; shift 2 ;;
    *) echo "build-site: unknown argument $1" >&2; exit 2 ;;
  esac
done
# The generator embeds the label and field catalogues, so they are exported
# from the client's sources before it is compiled.
cd "$here/web"
npm run --silent labels:export
npm run --silent fields:export
cd "$here/services/registry"
cargo build --release --quiet
cargo test --release --quiet 2>&1 | tail -3
bin="${CARGO_TARGET_DIR:-$here/services/registry/target}/release"
cd "$here/web"
npx tsc --noEmit
npx vite build --base "$base_path/" --logLevel warn
npx vitest run --reporter=dot
npm run --silent lint:no-arbitrary
cd "$here"
rm -rf docs
"$bin/recordgen" --bank bank --out docs --site-base "$site_base" --base-path "$base_path" --about about/body.html
cp -R web/dist-assets/assets docs/assets
[ -d bank/avatars ] && cp -R bank/avatars docs/avatars
touch docs/.nojekyll
(cd tools/prose-lint && npm install --silent --no-audit --no-fund >/dev/null && node --test >/dev/null)
node tools/prose-lint/src/cli.js docs \
  --labels services/registry/crates/record/labels.json \
  --fields services/registry/crates/record/fields.json \
  --about about/body.html --allowlist shared/html-allowlist.v1.json \
  --report "${TMPDIR:-/tmp}/mathesis-prose-lint.json"
