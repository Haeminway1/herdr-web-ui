#!/usr/bin/env bash
set -uo pipefail

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--dry-run" ]; }; then
  echo 'usage: fork-sync.sh [--dry-run]' >&2
  exit 2
fi

dry=0
[ "${1:-}" = "--dry-run" ] && dry=1
launcher_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
launcher_root="$(cd -- "$launcher_dir/.." && pwd -P)"
log() { echo "fork-sync: $*"; }
die() { log "$1"; exit 1; }

if [ -n "${FORK_SYNC_REPO:-}" ]; then
  [[ "$FORK_SYNC_REPO" = /* ]] || die 'FORK_SYNC_REPO must be an absolute registered worktree root'
  repo_root="$(cd -- "$FORK_SYNC_REPO" 2>/dev/null && pwd -P)" || die 'FORK_SYNC_REPO does not exist'
  registered_root="$(command git -C "$repo_root" rev-parse --show-toplevel 2>/dev/null)" || die 'FORK_SYNC_REPO is not a git worktree root'
  [ "$registered_root" = "$repo_root" ] || die 'FORK_SYNC_REPO is not the registered worktree root'
  command git -C "$repo_root" worktree list --porcelain 2>/dev/null |
    awk -v path="$repo_root" '$0 == "worktree " path { found=1 } END { exit !found }' ||
    die 'FORK_SYNC_REPO is not registered with git worktree'
else
  repo_root="$launcher_root"
fi

git() { command git -C "$repo_root" "$@"; }
state_root="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-web-ui-fork-sync"

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
working_state="$(git --no-optional-locks status --porcelain 2>/dev/null)" || die 'cannot inspect checkout'
if [ "$branch" != "deploy/haemin" ] || [ -n "$working_state" ]; then
  log 'refresh skipped: checkout is dirty or not deploy/haemin'
  exit 0
fi

if [ "$dry" -eq 0 ]; then
  umask 077
  mkdir -p "$state_root" || die 'cannot create sync state directory'
  chmod 700 "$state_root" || die 'cannot protect sync state directory'
  exec 9>"$state_root/sync.lock" || die 'cannot open global sync lock'
  flock -n 9 || { log 'another sync check is running'; exit 0; }

  before="$(git rev-parse HEAD)" || die 'cannot inspect deploy/haemin revision'
  git fetch -q origin deploy/haemin || die 'origin refresh failed'
  git merge --ff-only origin/deploy/haemin >/dev/null 2>&1 || die 'origin is not a fast-forward; no sync started'
  if [ "$(git rev-parse HEAD)" != "$before" ]; then
    log 'deploy refreshed; continuing with the invoked launcher policy'
  fi
fi

if [ "$dry" -eq 1 ]; then
  main_line="$(git ls-remote --heads upstream main 2>/dev/null)" || die 'upstream main is unreachable'
  target="${main_line%%[[:space:]]*}"
else
  git fetch -q --no-tags upstream refs/heads/main || die 'upstream main fetch failed'
  target="$(git rev-parse --verify 'FETCH_HEAD^{commit}' 2>/dev/null)" || die 'upstream main did not resolve to a commit'
fi

if ! [[ "$target" =~ ^[0-9a-f]{40,64}$ ]]; then
  die 'upstream main returned an invalid revision'
fi

short="${target:0:12}"
status_file="$state_root/main-$target.status"
agent_lock="$state_root/main-$target.agent.lock"
branch="sync/upstream-main-$short"
tree="$(dirname -- "$repo_root")/sync-upstream-main-$short"
runtime=""
log_file=""

status_field() {
  local file="$1" field="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^$field=//p" "$file" | head -1
}

read_status_field() { status_field "$status_file" "$1"; }

state="$(read_status_field state)"
attempt="$(read_status_field attempt)"
last_attempt="$(read_status_field updated_epoch)"
pane="$(read_status_field pane)"
runtime="$(read_status_field runtime)"
log_file="$(read_status_field log)"
validation_report="$(read_status_field validation_report)"
[[ "$attempt" =~ ^[0-9]+$ ]] || attempt=0
[[ "$last_attempt" =~ ^[0-9]+$ ]] || last_attempt=0

write_status() {
  local next_state="$1" reason="${2:-}" temporary="$status_file.tmp.$$" line field
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
    [ -z "$validation_report" ] || printf 'validation_report=%s\n' "$validation_report"
    [ -z "$runtime" ] || printf 'runtime=%s\n' "$runtime"
    [ -z "$log_file" ] || printf 'log=%s\n' "$log_file"
    if [ -f "$status_file" ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        field="${line%%=*}"
        case "$field" in
          state|target|attempt|updated_epoch|updated_at|branch|worktree|pane|reason|validation_report|runtime|log) ;;
          *) printf '%s\n' "$line" ;;
        esac
      done < "$status_file"
    fi
  } > "$temporary" || return 1
  chmod 600 "$temporary" || return 1
  mv -f -- "$temporary" "$status_file"
}

fail() {
  local reason="$1"
  if [ "$dry" -eq 0 ] && [ -n "${status_file:-}" ]; then write_status failed "$reason" || true; fi
  log "$reason"
  exit 1
}

full_validation_report_has_success() {
  local file="$1" expected_candidate="$2" report
  report="$(status_field "$file" validation_report)"
  [[ "$report" == /* ]] || return 1
  [ -f "$report" ] || return 1
  python3 -c 'import json,sys
def require(condition):
    if not condition:
        raise SystemExit(1)
with open(sys.argv[1], encoding="utf-8") as report_file:
    r=json.load(report_file)
sha=sys.argv[2]
required_report={"schemaVersion","runId","status","exitCode","startedAt","endedAt","durationMs","mode","revision","toolchain","source","verification","currentStep","steps","errors","browserArtifact","evidence"}
require(isinstance(r,dict) and required_report <= r.keys())
require(r["schemaVersion"] == 1)
require(isinstance(r["runId"],str) and bool(r["runId"]))
require(r["status"] == "success" and r["exitCode"] == 0)
require(isinstance(r["startedAt"],str) and isinstance(r["endedAt"],str) and isinstance(r["durationMs"],int))
require(r["mode"] == ["full"])
revision=r["revision"]
require(isinstance(revision,dict))
require({"head","testedSha","headSha","headBranch","baseBranch","baseSha","branch"} <= revision.keys())
require(revision["testedSha"] == sha and revision["head"] == sha and revision["headSha"] == sha)
require(all(revision[key] is None or isinstance(revision[key],str) for key in ("headBranch","baseBranch","baseSha","branch")))
toolchain=r["toolchain"]
require(isinstance(toolchain,dict))
require({"bunVersion","nodeVersion","herdrVersion","herdrTestShards","platform","arch","ci"} <= toolchain.keys())
require(isinstance(toolchain["bunVersion"],str) and bool(toolchain["bunVersion"]))
require(all(toolchain[key] is None or isinstance(toolchain[key],str) for key in ("nodeVersion","herdrVersion")))
require(toolchain["herdrTestShards"] is None or isinstance(toolchain["herdrTestShards"],int))
require(isinstance(toolchain["platform"],str) and bool(toolchain["platform"]))
require(isinstance(toolchain["arch"],str) and bool(toolchain["arch"]) and isinstance(toolchain["ci"],bool))
source=r["source"]
require(isinstance(source,dict) and source.get("unchanged") is True)
require(isinstance(source.get("start"),dict) and isinstance(source.get("end"),dict))
identity_fields={"head","branch","trackedDiffSha256","untrackedFiles","untrackedFileCount","untrackedContentSha256","untrackedFilesTruncated","fingerprint","reason"}
for identity in (source["start"],source["end"]):
    require(identity_fields <= identity.keys() and identity["head"] == sha)
    require(identity["branch"] is None or isinstance(identity["branch"],str))
    require(all(identity[key] is None or isinstance(identity[key],str) for key in ("trackedDiffSha256","untrackedContentSha256","fingerprint","reason")))
    require(isinstance(identity["untrackedFiles"],list))
    require(identity["untrackedFileCount"] is None or isinstance(identity["untrackedFileCount"],int))
    require(identity["untrackedFilesTruncated"] is None or isinstance(identity["untrackedFilesTruncated"],bool))
verification=r["verification"]
require(isinstance(verification,dict))
require({"scope","browserCurrentSource","status","reason"} <= verification.keys())
require(verification.get("status") == "verified")
require(verification.get("scope") == "source-state-and-step-results")
require(verification.get("browserCurrentSource") == "not-claimed")
require(verification["reason"] is None or isinstance(verification["reason"],str))
require(r["currentStep"] is None and r["errors"] == [])
browser=r["browserArtifact"]
require(isinstance(browser,dict))
require({"path","buildAttempted","buildThisRun","identity","finalIdentity","unchangedAfterBuild","provenance"} <= browser.keys())
require(isinstance(browser["path"],str) and bool(browser["path"]))
require(browser["buildAttempted"] is True and browser["buildThisRun"] is True)
require(browser["unchangedAfterBuild"] is True and browser["provenance"] == "built-this-run")
require(isinstance(browser["identity"],str) and bool(browser["identity"]))
require(browser["finalIdentity"] == browser["identity"])
evidence=r["evidence"]
require(isinstance(evidence,dict) and isinstance(evidence.get("logs"),list) and isinstance(evidence.get("artifacts"),list))
require(all(isinstance(path,str) for path in evidence["logs"] + evidence["artifacts"]))
names=["workflow syntax","generated types are fresh","generated themes are fresh","typecheck","build","unit tests","lanes"]
steps=r["steps"]
require(isinstance(steps,list))
require(all(isinstance(step,dict) for step in steps))
step_names=[step.get("name") for step in steps]
require(all(isinstance(name,str) and bool(name) for name in step_names))
positions=[]
for name in names:
    require(step_names.count(name) == 1)
    positions.append(step_names.index(name))
require(positions == sorted(positions))
for step in steps:
    require({"name","command","cwd","status","exitCode","signal","durationMs","startedAt","endedAt","stdout","stderr","reason"} <= step.keys())
    require(step["status"] == "success" and step["exitCode"] == 0)
    require(isinstance(step["command"],list) and bool(step["command"]))
    require(all(isinstance(argument,str) for argument in step["command"]))
    require(isinstance(step["cwd"],str) and bool(step["cwd"]))
    require(step["signal"] is None and isinstance(step["durationMs"],int))
    require(isinstance(step["startedAt"],str) and isinstance(step["endedAt"],str))
    require(isinstance(step["stdout"],str) and isinstance(step["stderr"],str))
    require(step["reason"] is None or isinstance(step["reason"],str))
' "$report" "$expected_candidate" >/dev/null 2>&1 || return 1
  return 0
}

receipt_has_success() {
  local file="$1" expected_target="$2" candidate_tree="$3" expected_attempt="$4"
  local receipt_target receipt_candidate receipt_attempt head changes
  [ -d "$candidate_tree" ] || return 1
  [ "$(status_field "$file" state)" = validated ] || return 1
  [ "$(status_field "$file" validation)" = local ] || return 1
  receipt_target="$(status_field "$file" target)"
  receipt_candidate="$(status_field "$file" candidate)"
  receipt_attempt="$(status_field "$file" attempt)"
  [ "$receipt_target" = "$expected_target" ] || return 1
  [ "$receipt_attempt" = "$expected_attempt" ] || return 1
  head="$(git -C "$candidate_tree" rev-parse HEAD 2>/dev/null)" || return 1
  [ "$receipt_candidate" = "$head" ] || return 1
  git -C "$candidate_tree" merge-base --is-ancestor "$expected_target" "$head" 2>/dev/null || return 1
  changes="$(git -C "$candidate_tree" status --porcelain 2>/dev/null)" || return 1
  [ -z "$changes" ] || return 1
  full_validation_report_has_success "$file" "$head"
}

validated_reference_candidate() {
  local file="$1" prior_target prior_attempt prior_candidate
  [ "$(status_field "$file" state)" = validated ] || return 1
  [ "$(status_field "$file" validation)" = local ] || return 1
  prior_target="$(status_field "$file" target)"
  prior_attempt="$(status_field "$file" attempt)"
  prior_candidate="$(status_field "$file" candidate)"
  [[ "${file##*/}" == "main-$prior_target.status" ]] || return 1
  [[ "$prior_target" =~ ^[0-9a-f]{40,64}$ ]] || return 1
  [[ "$prior_attempt" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$prior_candidate" =~ ^[0-9a-f]{40,64}$ ]] || return 1
  git -C "$repo_root" cat-file -e "$prior_candidate^{commit}" 2>/dev/null || return 1
  git -C "$repo_root" merge-base --is-ancestor "$prior_target" "$prior_candidate" 2>/dev/null || return 1
  full_validation_report_has_success "$file" "$prior_candidate" || return 1
  printf '%s\n' "$prior_candidate"
}

if git merge-base --is-ancestor "$target" HEAD 2>/dev/null; then
  if [ "$dry" -eq 1 ]; then
    log "upstream main $short is contained in deploy/haemin (read-only)"
    exit 0
  fi
  release_tag="$(git tag --contains "$target" --list 'v*' --sort=-version:refname | head -1)"
  if [ -n "$release_tag" ]; then
    write_status released "release_tag=$release_tag deploy_head=$(git rev-parse HEAD)" || die 'could not record released revision'
    log "upstream main $short is released by $release_tag"
  else
    write_status contained "deploy_head=$(git rev-parse HEAD)" || die 'could not record contained revision'
    log "upstream main $short is contained in deploy/haemin"
  fi
  exit 0
fi

if [ "$dry" -eq 1 ]; then
  log "upstream main changed to $target; a dedicated merge worktree would be checked"
  exit 0
fi

if [ "$state" = validated ] && receipt_has_success "$status_file" "$target" "$tree" "$attempt"; then
  log "upstream main $short is validated in $tree and awaits deploy/haemin containment"
  exit 0
fi
if [ "$state" = validated ]; then log 'validated receipt is stale or incomplete; resuming the existing attempt'; fi

exec 8>"$agent_lock" || fail 'cannot open per-target sync lock'
flock -n 8 || { log "a worker is already running for upstream main $short"; exit 0; }

retry_delay="${HERDR_FORK_SYNC_RETRY_SECONDS:-900}"
[[ "$retry_delay" =~ ^[0-9]+$ ]] || retry_delay=900
now="$(date +%s)"
if [ "$state" = failed ] && [ "$retry_delay" -gt 0 ] && [ $((now - last_attempt)) -lt "$retry_delay" ]; then
  log "last attempt failed; retry is available after $retry_delay seconds"
  exit 0
fi
if [ "$state" = started ]; then log "previous attempt is stale; resuming upstream main $short"; fi
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

previous_validated=""
previous_updated=-1
prior_candidate=""
for prior_status in "$state_root"/main-*.status; do
  [ -f "$prior_status" ] || continue
  [ "$prior_status" = "$status_file" ] && continue
  prior_updated="$(status_field "$prior_status" updated_epoch)"
  [[ "$prior_updated" =~ ^[0-9]+$ ]] || continue
  prior_candidate="$(validated_reference_candidate "$prior_status")" || continue
  if [ "$prior_updated" -gt "$previous_updated" ]; then
    previous_updated="$prior_updated"
    previous_validated="$prior_candidate"
  fi
done

prompt_file="$launcher_dir/fork-sync-prompt.md"
[ -f "$prompt_file" ] || fail 'fork-sync prompt is missing from the invoked launcher artifact'
worker_prompt="$state_root/main-$target.attempt-$attempt.prompt.md"
log_file="$state_root/main-$target.attempt-$attempt.log"
runtime=headless
{
  printf 'Sync attempt context (use these literal values):\n'
  printf 'FORK_SYNC_TARGET=%s\n' "$target"
  printf 'FORK_SYNC_WORKTREE=%s\n' "$tree"
  printf 'FORK_SYNC_BRANCH=%s\n' "$branch"
  printf 'FORK_SYNC_STATE_FILE=%s\n' "$status_file"
  printf 'FORK_SYNC_ATTEMPT=%s\n' "$attempt"
  printf 'FORK_SYNC_PREVIOUS_VALIDATED=%s\n' "$previous_validated"
  printf 'Treat any previous validated candidate as read-only integration context; do not alter or reset it.\n\n'
  prompt_text="$(<"$prompt_file")"
  prompt_text="${prompt_text//\$FORK_SYNC_TARGET/$target}"
  prompt_text="${prompt_text//\$FORK_SYNC_WORKTREE/$tree}"
  prompt_text="${prompt_text//\$FORK_SYNC_BRANCH/$branch}"
  prompt_text="${prompt_text//\$FORK_SYNC_STATE_FILE/$status_file}"
  prompt_text="${prompt_text//\$FORK_SYNC_ATTEMPT/$attempt}"
  prompt_text="${prompt_text//\$FORK_SYNC_PREVIOUS_VALIDATED/$previous_validated}"
  printf '%s\n' "$prompt_text"
} > "$worker_prompt" || fail 'could not prepare the per-attempt prompt'
chmod 600 "$worker_prompt" || fail 'could not protect the per-attempt prompt'
: > "$log_file" || fail 'could not create the private worker log'
chmod 600 "$log_file" || fail 'could not protect the worker log'
validation_report=""
write_status started "$merge_state" || { log 'could not record sync start'; exit 1; }

route_bin="${FORK_SYNC_ROUTE_BIN:-$HOME/dev/agents/builder/scripts/route}"
gjc_bin="${FORK_SYNC_GJC_BIN:-$HOME/.local/bin/gjc}"
resolve_executable() {
  local value="$1" resolved
  if [[ "$value" == */* ]]; then
    [ -x "$value" ] || return 1
    printf '%s\n' "$value"
  else
    resolved="$(command -v "$value" 2>/dev/null)" || return 1
    printf '%s\n' "$resolved"
  fi
}
route_bin="$(resolve_executable "$route_bin")" || fail 'implement route command is unavailable'
gjc_bin="$(resolve_executable "$gjc_bin")" || fail 'GJC command is unavailable'
route_field() { "$route_bin" resolve implement --field "$1" 2>>"$log_file"; }
model="$(route_field model)" || fail 'could not resolve the implement model'
provider="$(route_field provider)" || fail 'could not resolve the implement provider'
effort="$(route_field effort)" || fail 'could not resolve the implement effort'
[ -n "$model" ] || fail 'implement route resolved an empty model'
[ -n "$provider" ] || fail 'implement route resolved an empty provider'
[ -n "$effort" ] || fail 'implement route resolved an empty effort'

(
  cd -- "$tree" || exit 125
  FORK_SYNC_TARGET="$target" \
    FORK_SYNC_WORKTREE="$tree" \
    FORK_SYNC_BRANCH="$branch" \
    FORK_SYNC_STATE_FILE="$status_file" \
    FORK_SYNC_ATTEMPT="$attempt" \
    FORK_SYNC_PREVIOUS_VALIDATED="$previous_validated" \
    "$gjc_bin" -p --mode json --no-pty --provider "$provider" --model "$model" --thinking "$effort" "@$worker_prompt" 8>&- 9>&-
) > "$log_file" 2>&1
run_result=$?
validation_report="$(read_status_field validation_report)"

if [ "$run_result" -ne 0 ]; then
  if ! write_status failed "headless GJC exited with status $run_result"; then
    log 'could not atomically record the failed worker result'
  fi
  log "headless GJC failed with status $run_result; candidate preserved; log=$log_file"
  exit 1
fi

if ! receipt_has_success "$status_file" "$target" "$tree" "$attempt"; then
  if ! write_status failed 'worker exited successfully without matching validation evidence'; then
    log 'could not atomically record the missing validation evidence'
  fi
  log "worker exited without valid validation evidence; candidate preserved; log=$log_file"
  exit 1
fi

write_status validated 'matching validation evidence accepted' || { log 'validation passed but its receipt could not be finalized'; exit 1; }
log "upstream main $short validated in $tree; log=$log_file"
