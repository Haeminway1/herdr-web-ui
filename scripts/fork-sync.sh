#!/bin/bash
# Start one upstream release sync in a dedicated worktree. Never run from a stale deploy checkout.
set -uo pipefail
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--dry-run" ]; }; then
  echo 'usage: fork-sync.sh [--dry-run]' >&2
  exit 2
fi
dry=0; [ "${1:-}" = "--dry-run" ] && dry=1
root="$(cd "$(dirname "$0")/.." && pwd)"
state="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-web-ui-fork-sync"
log() { echo "fork-sync: $*"; }
git() { command git -C "$root" "$@"; }

# A non-deploy or dirty checkout cannot safely execute the policy it contains. Fetch failure or
# non-fast-forward similarly stops rather than silently continuing with stale instructions.
branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
working_state="$(git --no-optional-locks status --porcelain 2>/dev/null)" || { log 'cannot inspect checkout; no sync started'; exit 1; }
if [ "$branch" != deploy/haemin ] || [ -n "$working_state" ]; then
  log 'refresh skipped: checkout is dirty or not deploy/haemin; no sync started'
  exit 0
fi
if [ "$dry" -eq 0 ]; then
  before="$(git rev-parse HEAD)"
  git fetch -q origin deploy/haemin || { log 'origin refresh failed; no sync started'; exit 1; }
  git merge --ff-only origin/deploy/haemin || { log 'origin is not a fast-forward; no sync started'; exit 1; }
  if [ "$(git rev-parse HEAD)" != "$before" ]; then
    log 'deploy refreshed; restarting from refreshed policy'
    exec "$root/scripts/fork-sync.sh"
  fi
else
  log 'dry-run: refresh skipped (no refs or checkout changed)'
fi

latest="$(git ls-remote --tags --refs upstream 'v*' 2>/dev/null | grep -oE 'refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's#refs/tags/##' | sort -V | tail -1)"
[ -n "$latest" ] || { log 'upstream tags unreachable'; exit 0; }
[ ! -e "$state/$latest" ] || { log "$latest already handled"; exit 0; }
if [ "$dry" -eq 1 ]; then
  # Only inspect local objects; remote inspection must not write FETCH_HEAD or any ref.
  if git rev-parse -q --verify "refs/tags/$latest^{commit}" >/dev/null 2>&1 &&
     git merge-base --is-ancestor "refs/tags/$latest" HEAD 2>/dev/null; then
    log "$latest already contained (read-only)"
  else
    log "$latest may need sync; containment needs a fetch (read-only preview)"
  fi
  exit 0
fi
mkdir -p "$state"
git fetch -q upstream "refs/tags/$latest:refs/upstream-tags/$latest" --no-tags || { log "cannot fetch $latest"; exit 1; }
if git merge-base --is-ancestor "refs/upstream-tags/$latest" HEAD; then
  echo "contained $(date -Is)" > "$state/$latest"
  exit 0
fi

sync_branch="sync/upstream-$latest"
tree="$(dirname "$root")/sync-$latest"
log "upstream $latest is new: merging on $sync_branch in $tree"
echo "started $(date -Is)" > "$state/$latest"
if [ ! -d "$tree" ]; then
  git worktree add -q -b "$sync_branch" "$tree" HEAD || { log 'worktree failed'; rm -f "$state/$latest"; exit 1; }
fi
merge=clean
command git -C "$tree" merge --no-commit --no-ff "refs/upstream-tags/$latest" > "$state/$latest.merge.log" 2>&1 || merge="conflicts: $(command git -C "$tree" diff --name-only --diff-filter=U | wc -l) files"
echo "merge $merge" >> "$state/$latest"

herdr="${HERDR_BIN_PATH:-$HOME/.local/bin/herdr}"
prompt="$root/scripts/fork-sync-prompt.md"
created="$("$herdr" workspace create --cwd "$tree" --label "Web UI sync $latest" --no-focus 2>&1)"
pane="$(printf '%s' "$created" | grep -oE '"pane_id":"[^"]+"' | head -1 | cut -d'"' -f4)"
if [ -z "$pane" ]; then
  workspace="$(printf '%s' "$created" | grep -oE '"workspace_id":"[^"]+"' | head -1 | cut -d'"' -f4)"
  [ -n "$workspace" ] && pane="$workspace:p1"
fi
[ -n "$pane" ] || { log "herdr workspace failed: $created"; exit 1; }
"$herdr" pane run "$pane" "UPSTREAM_TAG=$latest MERGE_STATE='$merge' claude \"\$(sed -e 's#{{TAG}}#$latest#g' -e 's#{{TREE}}#$tree#g' -e 's#{{MERGE}}#$merge#g' '$prompt')\"" > /dev/null
log "agent started in pane $pane ($merge)"
