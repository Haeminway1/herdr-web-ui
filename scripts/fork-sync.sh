#!/usr/bin/env bash
set -uo pipefail

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--dry-run" ]; }; then
  echo 'usage: fork-sync.sh [--dry-run]' >&2
  exit 2
fi

dry=0
[ "${1:-}" = "--dry-run" ] && dry=1
root="$(cd "$(dirname "$0")/.." && pwd)"
state_root="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-web-ui-fork-sync"
log() { echo "fork-sync: $*"; }
git() { command git -C "$root" "$@"; }

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
working_state="$(git --no-optional-locks status --porcelain 2>/dev/null)" || { log 'cannot inspect checkout'; exit 1; }
if [ "$branch" != "deploy/haemin" ] || [ -n "$working_state" ]; then
  log 'refresh skipped: checkout is dirty or not deploy/haemin'
  exit 0
fi

if [ "$dry" -eq 0 ]; then
  mkdir -p "$state_root" || { log 'cannot create sync state directory'; exit 1; }
  if [ "${FORK_SYNC_LOCK_HELD:-0}" != "1" ]; then
    exec 9>"$state_root/sync.lock"
    flock -n 9 || { log 'another sync check is running'; exit 0; }
  fi
  before="$(git rev-parse HEAD)"
  git fetch -q origin deploy/haemin || { log 'origin refresh failed'; exit 1; }
  git merge --ff-only origin/deploy/haemin >/dev/null 2>&1 || { log 'origin is not a fast-forward; no sync started'; exit 1; }
  if [ "$(git rev-parse HEAD)" != "$before" ]; then
    log 'deploy refreshed; restarting with the refreshed policy'
    FORK_SYNC_LOCK_HELD=1 exec "$root/scripts/fork-sync.sh"
  fi
fi

if [ "$dry" -eq 1 ]; then
  main_line="$(git ls-remote --heads upstream main 2>/dev/null)" || { log 'upstream main is unreachable'; exit 1; }
  target="${main_line%%[[:space:]]*}"
else
  git fetch -q --no-tags upstream refs/heads/main || { log 'upstream main fetch failed'; exit 1; }
  target="$(git rev-parse --verify 'FETCH_HEAD^{commit}' 2>/dev/null)" || { log 'upstream main did not resolve to a commit'; exit 1; }
fi

if ! [[ "$target" =~ ^[0-9a-f]{40,64}$ ]]; then
  log 'upstream main returned an invalid revision'
  exit 1
fi

short="${target:0:12}"
status_file="$state_root/main-$target.status"
agent_lock="$state_root/main-$target.agent.lock"
branch="sync/upstream-main-$short"
tree="$(dirname "$root")/sync-upstream-main-$short"

read_status_field() {
  local field="$1"
  [ -f "$status_file" ] || return 0
  sed -n "s/^$field=//p" "$status_file" | head -1
}

state="$(read_status_field state)"
attempt="$(read_status_field attempt)"
last_attempt="$(read_status_field updated_epoch)"
pane="$(read_status_field pane)"
[[ "$attempt" =~ ^[0-9]+$ ]] || attempt=0
[[ "$last_attempt" =~ ^[0-9]+$ ]] || last_attempt=0

write_status() {
  local next_state="$1" reason="${2:-}" temporary="$status_file.tmp.$$"
  {
    printf 'state=%s\n' "$next_state"
    printf 'target=%s\n' "$target"
    printf 'attempt=%s\n' "$attempt"
    printf 'updated_epoch=%s\n' "$(date +%s)"
    printf 'updated_at=%s\n' "$(date -Is)"
    printf 'branch=%s\n' "$branch"
    printf 'worktree=%s\n' "$tree"
    printf 'pane=%s\n' "$pane"
    printf 'reason=%s\n' "$reason"
  } > "$temporary" || return 1
  mv "$temporary" "$status_file"
}

fail() {
  local reason="$1"
  if [ "$dry" -eq 0 ] && [ -n "$status_file" ]; then write_status failed "$reason" || true; fi
  log "$reason"
  exit 1
}

if git merge-base --is-ancestor "$target" HEAD 2>/dev/null; then
  if [ "$dry" -eq 1 ]; then
    log "upstream main $short is contained in deploy/haemin (read-only)"
    exit 0
  fi
  release_tag="$(git tag --contains "$target" --list 'v*' --sort=-version:refname | head -1)"
  if [ -n "$release_tag" ]; then
    write_status released "release_tag=$release_tag deploy_head=$(git rev-parse HEAD)" || { log 'could not record released revision'; exit 1; }
    log "upstream main $short is released by $release_tag"
  else
    write_status contained "deploy_head=$(git rev-parse HEAD)" || { log 'could not record contained revision'; exit 1; }
    log "upstream main $short is contained in deploy/haemin"
  fi
  exit 0
fi

if [ "$dry" -eq 1 ]; then
  log "upstream main changed to $target; a dedicated merge worktree would be checked"
  exit 0
fi

if [ "$state" = "validated" ] && [ -d "$tree" ] && git -C "$tree" merge-base --is-ancestor "$target" HEAD 2>/dev/null && [ -z "$(git -C "$tree" status --porcelain 2>/dev/null)" ]; then
  log "upstream main $short is validated in $tree and awaits deploy/haemin containment"
  exit 0
fi
if [ "$state" = "validated" ]; then log 'validated marker lacks actual target containment; resuming the existing attempt'; fi

if ! flock -n "$agent_lock" -c true >/dev/null 2>&1; then
  log "an agent is already running for upstream main $short"
  exit 0
fi

retry_delay="${HERDR_FORK_SYNC_RETRY_SECONDS:-900}"
[[ "$retry_delay" =~ ^[0-9]+$ ]] || retry_delay=900
now="$(date +%s)"
if [ "$state" = "failed" ] && [ "$retry_delay" -gt 0 ] && [ $((now - last_attempt)) -lt "$retry_delay" ]; then
  log "last attempt failed; retry is available after $retry_delay seconds"
  exit 0
fi
if [ "$state" = "started" ]; then log "previous attempt is stale; resuming upstream main $short"; fi
attempt=$((attempt + 1))

registered=0
if git worktree list --porcelain | awk -v path="$tree" '$0 == "worktree " path { found=1 } END { exit !found }'; then registered=1; fi
if [ -e "$tree" ] && [ "$registered" -eq 0 ]; then fail 'sync worktree path exists but is not registered; preserving it for review'; fi
if [ "$registered" -eq 1 ]; then
  tree_branch="$(git -C "$tree" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [ "$tree_branch" = "$branch" ] || fail 'sync worktree is on an unexpected branch; preserving it for review'
elif git show-ref --verify --quiet "refs/heads/$branch"; then
  git worktree add -q "$tree" "$branch" || fail 'could not reattach the existing sync branch'
else
  git worktree add -q -b "$branch" "$tree" HEAD || fail 'could not create the dedicated sync worktree'
fi

merge_head="$(git -C "$tree" rev-parse -q --verify MERGE_HEAD 2>/dev/null || true)"
merge_state=""
if [ -n "$merge_head" ]; then
  conflicts="$(git -C "$tree" diff --name-only --diff-filter=U | wc -l | tr -d ' ')"
  merge_state="resuming merge in progress; conflicts=$conflicts"
elif git -C "$tree" merge-base --is-ancestor "$target" HEAD 2>/dev/null; then
  merge_state='target already committed; validation may resume'
else
  tree_changes="$(git -C "$tree" status --porcelain 2>/dev/null)" || fail 'cannot inspect sync worktree'
  if [ -n "$tree_changes" ]; then
    merge_state='resuming existing worktree changes without reset'
  else
    deploy_head="$(git rev-parse HEAD)"
    tree_head="$(git -C "$tree" rev-parse HEAD)"
    if git merge-base --is-ancestor "$tree_head" "$deploy_head" 2>/dev/null; then
      git -C "$tree" merge --ff-only "$deploy_head" >/dev/null 2>&1 || fail 'could not advance the sync worktree to current deploy/haemin'
    elif ! git merge-base --is-ancestor "$deploy_head" "$tree_head" 2>/dev/null; then
      fail 'sync worktree diverged from deploy/haemin; preserving both histories'
    fi
    merge_log="$state_root/main-$target.merge.log"
    git -C "$tree" merge --no-commit --no-ff "$target" > "$merge_log" 2>&1
    merge_result=$?
    merge_head="$(git -C "$tree" rev-parse -q --verify MERGE_HEAD 2>/dev/null || true)"
    if [ -n "$merge_head" ]; then
      conflicts="$(git -C "$tree" diff --name-only --diff-filter=U | wc -l | tr -d ' ')"
      merge_state="merge in progress; conflicts=$conflicts"
    elif git -C "$tree" merge-base --is-ancestor "$target" HEAD 2>/dev/null; then
      merge_state='target already contained in sync branch'
    else
      fail "upstream merge failed with exit $merge_result; details are in $merge_log"
    fi
  fi
fi

write_status started "$merge_state" || { log 'could not record sync start'; exit 1; }

herdr="${HERDR_BIN_PATH:-$HOME/.local/bin/herdr}"
if [ -z "$pane" ]; then
  created="$("$herdr" workspace create --cwd "$tree" --label "Web UI sync main $short" --no-focus 2>&1)"
  create_result=$?
  pane="$(printf '%s' "$created" | grep -oE '"pane_id":"[^"]+"' | head -1 | cut -d'"' -f4)"
  if [ -z "$pane" ]; then
    workspace="$(printf '%s' "$created" | grep -oE '"workspace_id":"[^"]+"' | head -1 | cut -d'"' -f4)"
    [ -z "$workspace" ] || pane="$workspace:p1"
  fi
  if [ "$create_result" -ne 0 ] || [ -z "$pane" ]; then fail 'Herdr workspace creation failed; state remains retryable'; fi
  write_status started "$merge_state" || { log 'could not record the created workspace'; exit 1; }
fi

prompt_file="$root/scripts/fork-sync-prompt.md"
[ -f "$prompt_file" ] || fail 'fork-sync prompt is missing'
prompt_text="$(<"$prompt_file")"
printf -v quoted_prompt '%q' "$prompt_text"
printf -v agent_command 'flock -n %q env FORK_SYNC_TARGET=%q FORK_SYNC_WORKTREE=%q FORK_SYNC_BRANCH=%q FORK_SYNC_STATE_FILE=%q FORK_SYNC_ATTEMPT=%q claude %s' \
  "$agent_lock" "$target" "$tree" "$branch" "$status_file" "$attempt" "$quoted_prompt"
run_output="$(FORK_SYNC_AGENT_LOCK="$agent_lock" "$herdr" pane run "$pane" "$agent_command" 9>&- 2>&1)"
run_result=$?
if [ "$run_result" -ne 0 ]; then
  if printf '%s' "$run_output" | grep -Eiq 'pane_not_found|pane not found|no such pane'; then pane=""; fi
  write_status failed "agent launch failed with exit $run_result" || true
  log "agent launch failed with exit $run_result; attempt $attempt remains visible and retryable"
  exit 1
fi
write_status started "$merge_state" || { log 'agent started but its status could not be recorded'; exit 1; }
log "agent started for upstream main $short in pane $pane ($merge_state)"
