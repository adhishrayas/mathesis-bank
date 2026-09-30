#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# Give every profile in the bank the picture GitHub already has for them.
#
#   bash bank/tools/fetch-avatars.sh            # fetch the ones that are missing
#   bash bank/tools/fetch-avatars.sh --all      # re-fetch every one, replacing what is here
#   bash bank/tools/fetch-avatars.sh --dry-run  # say what would be fetched
#
# WHY THIS FILE EXISTS
#
# The backend names it — backend/auth.py's docstring says "that is where bank/tools/
# fetch-avatars.sh gets it" — and it has never existed. So `bank/avatars/` held exactly one
# file, put there by hand, and every other depositor rendered without a picture. The site now
# falls back to a generated glyph, which is the right behaviour for someone who has no photo;
# it is the wrong behaviour for everyone who does and was never asked.
#
# WHY THE URL IS DERIVED AND NOT STORED
#
# `avatars.githubusercontent.com/u/<numeric id>` is stable for the life of an account: it
# survives a rename, which `github.com/<login>.png` does not. The numeric id is already in
# profiles.json as `github_user_id`, so nothing new is recorded to make this work — auth.py
# derives the same URL from the same number for the signed-in reader, and the two agree because
# there is one fact and neither stores it.
#
# WHAT IT WRITES
#
# `bank/avatars/<login>.jpg`, and `avatar: "/avatars/<login>.jpg"` on that profile. The path is
# site-absolute because it is rendered as an `src` on pages at every depth.
#
# A profile with no `github_user_id` is skipped rather than guessed at: an entry can exist for
# someone the bank cites without their ever having signed in, and there is no picture to fetch.
# ---------------------------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILES="$ROOT/bank/profiles.json"
OUT="$ROOT/bank/avatars"
SIZE="${MATHESIS_AVATAR_SIZE:-160}"

ALL=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

test -f "$PROFILES" || { echo "FATAL: no $PROFILES" >&2; exit 1; }
mkdir -p "$OUT"

# One pass to decide, so the fetches and the rewrite cannot disagree about who needs one.
# `while read`, not `mapfile`: macOS ships bash 3.2 and has neither mapfile nor readarray, and
# this script is run by hand on whatever laptop is to hand.
WANTED=()
while IFS= read -r line; do
  [ -n "$line" ] && WANTED+=("$line")
done < <(
  ALL="$ALL" python3 - "$PROFILES" <<'PY'
import json, os, sys
want_all = os.environ.get("ALL") == "1"
for p in json.load(open(sys.argv[1])):
    gid, login = p.get("github_user_id"), p.get("login")
    if not gid or not login:
        continue
    if p.get("avatar") and not want_all:
        continue
    print(f"{login}\t{gid}")
PY
)

if [ "${#WANTED[@]}" -eq 0 ]; then
  echo "  every profile already has a picture"
  exit 0
fi

FETCHED=()
for row in "${WANTED[@]}"; do
  login="${row%%$'\t'*}"
  gid="${row##*$'\t'}"
  url="https://avatars.githubusercontent.com/u/${gid}?s=${SIZE}&v=4"
  dest="$OUT/${login}.jpg"
  if [ "$DRY" -eq 1 ]; then
    echo "  would fetch $login <- $url"
    continue
  fi
  # --fail so a 404 is an error and not a zero-byte file committed as a portrait.
  if curl -sSfL --max-time 30 "$url" -o "$dest.part"; then
    # A GitHub avatar is a PNG as often as a JPEG whatever the extension says, and browsers
    # sniff it. What matters is that it is an image at all: an HTML error page written to
    # <login>.jpg would render as a broken picture on every page that author appears on.
    if [ ! -s "$dest.part" ] || ! file -b --mime-type "$dest.part" | grep -q '^image/'; then
      rm -f "$dest.part"
      echo "  SKIPPED $login: what came back is not an image" >&2
      continue
    fi
    mv "$dest.part" "$dest"
    FETCHED+=("$login")
    echo "  $login -> bank/avatars/${login}.jpg ($(wc -c <"$dest" | tr -d ' ') bytes)"
  else
    rm -f "$dest.part"
    echo "  SKIPPED $login: GitHub did not serve $url" >&2
  fi
done

if [ "$DRY" -eq 1 ] || [ "${#FETCHED[@]}" -eq 0 ]; then
  exit 0
fi

# Only the profiles whose picture actually arrived. A path written for a file that is not there
# is worse than no path: it renders as a broken image rather than as the glyph.
# The logins go in as ARGUMENTS, not on stdin. A heredoc is already stdin here — it is how the
# program itself is fed to `python3 -` — so anything piped in is discarded, silently, and the
# rewrite runs over an empty set while reporting success.
python3 - "$PROFILES" "${FETCHED[@]}" <<'PY'
import json, sys
path = sys.argv[1]
got = set(sys.argv[2:])
profiles = json.load(open(path))
for p in profiles:
    if p.get("login") in got:
        p["avatar"] = f"/avatars/{p['login']}.jpg"
open(path, "w").write(json.dumps(profiles, indent=2) + "\n")
print(f"  profiles.json: {len(got)} updated")
PY
