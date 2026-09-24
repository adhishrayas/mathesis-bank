#!/usr/bin/env bash
# fetch-avatars.sh — copy each profile's public GitHub avatar into bank/avatars/,
# so the record serves it itself and a page makes no third-party request.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$here/bank/avatars"
python3 - "$here/bank/curation.json" <<'PY' | while read -r login id; do
import json, sys
p = json.load(open(sys.argv[1]))["profile"]
print(p["login"], p["github_user_id"])
PY
  tmp="$(mktemp)"
  curl -fsSL "https://avatars.githubusercontent.com/u/$id?s=160&v=4" -o "$tmp"
  case "$(file -b --mime-type "$tmp")" in
    image/jpeg) ext=jpg ;; image/png) ext=png ;; image/gif) ext=gif ;; image/webp) ext=webp ;;
    *) echo "fetch-avatars: $login: not an image" >&2; rm -f "$tmp"; exit 1 ;;
  esac
  rm -f "$here/bank/avatars/$login".*
  mv "$tmp" "$here/bank/avatars/$login.$ext"
  echo "fetch-avatars: $login -> bank/avatars/$login.$ext"
done
