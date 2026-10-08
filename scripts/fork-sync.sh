#!/bin/bash
# Fork sync (deploy/haemin, DEPLOY-FORK.md): the moment upstream publishes a release, start merging it.
#   scripts/fork-sync.sh            check once; run by herdr-web-ui-fork-sync.timer
#   scripts/fork-sync.sh --dry-run  say what it would do, change nothing
# A check is one `git ls-remote` of upstream's tags. Only a release tag that deploy/haemin does not
# contain yet starts work: a worktree on sync/upstream-<tag> with the merge begun, and a herdr
# workspace where an agent finishes it (scripts/fork-sync-prompt.md): conflicts resolved so every
# fork feature in DEPLOY-FORK.md keeps working, then scripts/fork-release.sh. The workspace is the
# notification: it shows in every herdr web UI, and asks there when it needs a decision.
set -uo pipefail
dry=0; [ "${1:-}" = "--dry-run" ] && dry=1
root="$(cd "$(dirname "$0")/.." && pwd)"
state="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-web-ui-fork-sync"
mkdir -p "$state"
log() { echo "fork-sync: $*"; }
git() { command git -C "$root" "$@"; }

latest="$(git ls-remote --tags --refs upstream 'v*' 2>/dev/null | grep -oE 'refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's#refs/tags/##' | sort -V | tail -1)"
[ -n "$latest" ] || { log "upstream tags unreachable"; exit 0; }
# a tag already taken in hand (in progress or done) is not started twice
if [ -e "$state/$latest" ]; then exit 0; fi
git fetch -q upstream "refs/tags/$latest:refs/upstream-tags/$latest" --no-tags 2>/dev/null || { log "cannot fetch $latest"; exit 0; }
git fetch -q origin deploy/haemin 2>/dev/null || true
if git merge-base --is-ancestor "refs/upstream-tags/$latest" origin/deploy/haemin 2>/dev/null; then
  [ $dry -eq 1 ] || echo "contained $(date -Is)" > "$state/$latest"
  exit 0
fi

branch="sync/upstream-$latest"
tree="$(dirname "$root")/sync-$latest"
log "upstream $latest is new: merging on $branch in $tree"
[ $dry -eq 1 ] && exit 0
echo "started $(date -Is)" > "$state/$latest"
if [ ! -d "$tree" ]; then
  git worktree add -q -b "$branch" "$tree" origin/deploy/haemin || { log "worktree failed"; rm -f "$state/$latest"; exit 1; }
fi
merge="clean"
command git -C "$tree" merge --no-commit --no-ff "refs/upstream-tags/$latest" > "$state/$latest.merge.log" 2>&1 || merge="conflicts: $(command git -C "$tree" diff --name-only --diff-filter=U | wc -l) files"
echo "merge $merge" >> "$state/$latest"

herdr="${HERDR_BIN_PATH:-$HOME/.local/bin/herdr}"
prompt="$root/scripts/fork-sync-prompt.md"
created="$("$herdr" workspace create --cwd "$tree" --label "Web UI 동기화 $latest" --no-focus 2>&1)"
pane="$(printf '%s' "$created" | grep -oE '"pane_id":"[^"]+"' | head -1 | cut -d'"' -f4)"
if [ -z "$pane" ]; then
  workspace="$(printf '%s' "$created" | grep -oE '"workspace_id":"[^"]+"' | head -1 | cut -d'"' -f4)"
  [ -n "$workspace" ] && pane="$workspace:p1"
fi
[ -n "$pane" ] || { log "herdr workspace failed: $created"; exit 1; }
# the prompt names the tag, the tree and what the merge left; the agent reads the rest from the repo
"$herdr" pane run "$pane" "UPSTREAM_TAG=$latest MERGE_STATE='$merge' claude \"\$(sed -e 's#{{TAG}}#$latest#g' -e 's#{{TREE}}#$tree#g' -e 's#{{MERGE}}#$merge#g' '$prompt')\"" > /dev/null
log "agent started in pane $pane ($merge)"
