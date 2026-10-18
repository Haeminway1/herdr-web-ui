#!/usr/bin/env bash
set -uo pipefail

version="${1:?usage: fork-release.sh X.Y.Z}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'fork-release: version must be X.Y.Z' >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)"
state="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-web-ui-fork-sync"
logs="$(mktemp -d)"
status_file="$state/release-$version.status"
head=""
log() { echo "fork-release: $*"; }
git() { command git -C "$root" "$@"; }

mkdir -p "$state" || { log 'cannot create release state directory'; exit 1; }
exec 9>"$state/release.lock"
flock -n 9 || { log "another release is running; nothing tagged" >&2; exit 1; }

write_status() {
  local state_name="$1" detail="${2:-}" temporary="$status_file.tmp.$$"
  {
    printf 'state=%s\n' "$state_name"
    printf 'version=%s\n' "$version"
    printf 'head=%s\n' "$head"
    printf 'updated_at=%s\n' "$(date -Is)"
    printf 'detail=%s\n' "$detail"
    printf 'logs=%s\n' "$logs"
  } > "$temporary" && mv "$temporary" "$status_file"
}

fail() {
  local reason="$1"
  write_status failed "$reason"
  log "$reason (logs in $logs); nothing released" >&2
  exit 1
}

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[ "$branch" = "deploy/haemin" ] || fail 'release is allowed only from deploy/haemin'
[ -z "$(git status --porcelain)" ] || fail 'the checkout is not clean'
head="$(git rev-parse HEAD)" || fail 'could not resolve HEAD'
write_status running 'release gates started' || fail 'could not record release start'

package_version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)".*/\1/p' "$root/package.json" | head -1)"
plugin_version="$(sed -n 's/^version = "\([0-9.]*\)"$/\1/p' "$root/herdr-plugin.toml" | head -1)"
[ "$package_version" = "$version" ] || fail 'package.json version does not match the requested version'
[ "$plugin_version" = "$version" ] || fail 'herdr-plugin.toml version does not match the requested version'

published_tags="$(git ls-remote --tags --refs origin 'refs/tags/v*' 2>"$logs/tags.log")" || fail 'could not read published fork tags'
latest="$(printf '%s\n' "$published_tags" | awk '$2 ~ /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/ { sub(/^refs\/tags\/v/, "", $2); print $2 }' | sort -V | tail -1)"
[ -z "$latest" ] || [ "$(printf '%s\n' "$latest" "$version" | sort -V | tail -1)" = "$version" ] || fail 'requested version is older than a published fork tag'
[ -z "$latest" ] || [ "$latest" != "$version" ] || fail 'requested version is already published'
[ -z "$(git ls-remote --tags --refs origin "refs/tags/v$version" 2>/dev/null)" ] || fail 'requested tag already exists on origin'

cd "$root" || fail 'could not enter the repository'
bun install --frozen-lockfile > "$logs/install.log" 2>&1 || fail 'locked dependency install failed'
bun run check fast > "$logs/fast.log" 2>&1 || fail 'Fast checks failed'
bun run check integration browser > "$logs/integration-browser.log" 2>&1 || fail 'Integration and browser checks failed'

checks="$(gh api "repos/Haeminway1/herdr-web-ui/commits/$head/check-runs" --jq '.check_runs | sort_by(.completed_at) | reverse | .[] | [.name, .status, .conclusion] | @tsv' 2>"$logs/check-runs.log")" || fail 'could not read required checks for this commit'
for gate in 'Fast checks' 'Integration and browser' 'Native Windows install'; do
  result="$(printf '%s\n' "$checks" | awk -F '\t' -v gate="$gate" '$1 == gate { print $2 " " $3; exit }')"
  [ "$result" = 'completed success' ] || fail "required check is not passing for $head: $gate"
done

[ -z "$(git status --porcelain)" ] || fail 'the checks left the checkout changed'
head="$(git rev-parse HEAD)"
tag="v$version"
local_tag="$(git rev-parse -q --verify "refs/tags/$tag^{commit}" 2>/dev/null || true)"
if [ -n "$local_tag" ] && [ "$local_tag" != "$head" ]; then fail 'a local tag with this version points to a different commit'; fi
if [ -z "$local_tag" ]; then git tag "$tag" "$head" || fail 'could not create the release tag'; fi
git push --atomic origin HEAD:deploy/haemin "refs/tags/$tag" > "$logs/push.log" 2>&1 || fail 'atomic branch and tag push failed'

for target_status in "$state"/main-*.status; do
  [ -f "$target_status" ] || continue
  target="$(sed -n 's/^target=//p' "$target_status" | head -1)"
  [[ "$target" =~ ^[0-9a-f]{40,64}$ ]] || continue
  if git cat-file -e "$target^{commit}" 2>/dev/null && git merge-base --is-ancestor "$target" "$head"; then
    temporary="$target_status.tmp.$$"
    awk -v tag="$tag" -v head="$head" '
      BEGIN { state_written=0 }
      /^state=/ { print "state=released"; state_written=1; next }
      /^release_tag=/ || /^release_head=/ { next }
      { print }
      END {
        if (!state_written) print "state=released"
        print "release_tag=" tag
        print "release_head=" head
      }
    ' "$target_status" > "$temporary" && mv "$temporary" "$target_status"
  fi
done

write_status released "tag=$tag" || fail 'release was pushed but its outcome could not be recorded'
log "released $tag at $head"
