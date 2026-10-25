#!/usr/bin/env bash
set -uo pipefail

version="${1:?usage: fork-release.sh X.Y.Z}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'fork-release: version must be X.Y.Z' >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd -P)"
launcher_dir="$(cd "$(dirname "$0")" && pwd -P)"
state="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-web-ui-fork-sync"
logs="$(mktemp -d /tmp/herdr-web-ui-fork-release.XXXXXX)" || { echo 'fork-release: cannot create release logs' >&2; exit 1; }
status_file="$state/release-$version.status"
head=""
hosted_checks=""
local_gate_report=""
skipped=""
dispatch_ref=""
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
    [ -z "$hosted_checks" ] || printf 'hosted_checks=%s\n' "$hosted_checks"
    [ -z "$local_gate_report" ] || printf 'local_gate_report=%s\n' "$local_gate_report"
    [ -z "$skipped" ] || printf 'skipped=%s\n' "$skipped"
  } > "$temporary" && mv "$temporary" "$status_file"
}

fail() {
  local reason="$1"
  write_status failed "$reason" || true
  log "$reason (logs in $logs); nothing released" >&2
  exit 1
}

source "$launcher_dir/full-validation-report.sh" || fail 'cannot load full validation report checker'

assert_source_state() {
  local stage="$1" current_head changes
  current_head="$(git rev-parse HEAD 2>/dev/null)" || fail "cannot inspect HEAD after $stage"
  [ "$current_head" = "$head" ] || fail "HEAD changed after $stage"
  changes="$(git status --porcelain 2>/dev/null)" || fail "cannot inspect checkout after $stage"
  [ -z "$changes" ] || fail "the checkout changed after $stage"
}

run_checked_command() {
  local stage="$1" output="$2" failure="$3" exit_code=0
  shift 3
  "$@" > "$output" 2>&1 || exit_code=$?
  assert_source_state "$stage"
  [ "$exit_code" -eq 0 ] || fail "$failure"
}

check_runs_state() {
  local file="${1:-$logs/check-runs.json}"
  python3 - "$file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as check_file:
    output = check_file.read()
decoder = json.JSONDecoder()
pages = []
while output.strip():
    output = output.lstrip()
    page, consumed = decoder.raw_decode(output)
    pages.append(page)
    output = output[consumed:]
if not pages or not all(isinstance(page, dict) and type(page.get("total_count")) is int and isinstance(page.get("check_runs"), list) for page in pages):
    raise SystemExit(1)
total_count = pages[0]["total_count"]
if any(page["total_count"] != total_count for page in pages):
    raise SystemExit(1)
runs = [run for page in pages for run in page["check_runs"]]
if total_count != len(runs):
    raise SystemExit(1)
if not runs:
    print("empty")
    raise SystemExit(0)
if not all(isinstance(run, list) and len(run) == 4 and isinstance(run[0], str) and isinstance(run[1], str) and (run[2] is None or isinstance(run[2], str)) and (run[3] is None or isinstance(run[3], str)) for run in runs):
    raise SystemExit(1)
runs.sort(key=lambda run: run[3] or "", reverse=True)
required = ("Fast checks", "Integration and browser", "Native Windows install")
for name in required:
    matches = [run for run in runs if run[0] == name]
    if not matches:
        print("missing")
        raise SystemExit(0)
    _, status, conclusion, _ = matches[0]
    if status != "completed":
        print("pending")
        raise SystemExit(0)
    if conclusion != "success":
        print("failed")
        raise SystemExit(0)
print("pass")
PY
}

fetch_check_runs() {
  local output="$1" error_log="$2"
  gh api --paginate --jq '{total_count, check_runs: [.check_runs[] | [.name, .status, .conclusion, .started_at]]}' \
    "repos/Haeminway1/herdr-web-ui/commits/$head/check-runs" >"$output" 2>"$error_log"
}

remote_ref_sha() {
  local refs="$1" expected_ref="$2"
  printf '%s\n' "$refs" | awk -v ref="$expected_ref" '$2 == ref { print $1; exit }'
}

choose_dispatch_ref() {
  local refs existing_sha candidate candidate_ref
  refs="$(git ls-remote --heads origin 2>"$logs/origin-branches.log")" || fail 'could not read origin branches for workflow dispatch'
  dispatch_ref="$(printf '%s\n' "$refs" | awk -v expected="$head" '$1 == expected && $2 ~ /^refs\/heads\// { sub(/^refs\/heads\//, "", $2); if ($2 != expected) { print $2; exit } }')"
  if [ -n "$dispatch_ref" ]; then
    return 0
  fi

  candidate="release/candidate-$version-$head"
  candidate_ref="refs/heads/$candidate"
  existing_sha="$(remote_ref_sha "$refs" "$candidate_ref")"
  if [ -n "$existing_sha" ]; then
    [ "$existing_sha" = "$head" ] || fail "candidate branch already exists at a different commit: $candidate"
    dispatch_ref="$candidate"
    return 0
  fi

  git push --no-follow-tags origin "$head:$candidate_ref" >"$logs/candidate-branch.log" 2>&1 || fail 'could not publish an exact-HEAD candidate branch'
  refs="$(git ls-remote --heads origin 2>"$logs/origin-branches.log")" || fail 'could not verify candidate branch publication'
  existing_sha="$(remote_ref_sha "$refs" "$candidate_ref")"
  [ "$existing_sha" = "$head" ] || fail 'candidate branch does not point to the release HEAD'
  dispatch_ref="$candidate"
}

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[ "$branch" = "deploy/haemin" ] || fail 'release is allowed only from deploy/haemin'
working_state="$(git status --porcelain 2>/dev/null)" || fail 'cannot inspect checkout'
[ -z "$working_state" ] || fail 'the checkout is not clean'
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
existing_tag="$(git ls-remote --tags --refs origin "refs/tags/v$version" 2>"$logs/tag-exists.log")" || fail 'could not inspect the requested tag on origin'
[ -z "$existing_tag" ] || fail 'requested tag already exists on origin'

cd "$root" || fail 'could not enter the repository'
run_checked_command 'locked dependency install' "$logs/install.log" 'locked dependency install failed' bun install --frozen-lockfile
run_checked_command 'Fast checks' "$logs/fast.log" 'Fast checks failed' bun run check fast

# GitHub answers check-runs only for commits it has; publish the exact-HEAD ref first.
choose_dispatch_ref
fetch_check_runs "$logs/check-runs.json" "$logs/check-runs.log" || fail 'could not read required checks for this commit'
check_state="$(check_runs_state)" || fail 'check-runs response was malformed or incomplete'

case "$check_state" in
  pass)
    ;;
  empty)
    if gh api -X POST repos/Haeminway1/herdr-web-ui/actions/workflows/ci.yml/dispatches \
      -f "ref=$dispatch_ref" >"$logs/dispatch.out" 2>"$logs/dispatch.log"; then
      fetch_check_runs "$logs/check-runs-after-dispatch.json" "$logs/check-runs-after-dispatch.log" || fail 'could not read checks after successful workflow dispatch'
      check_state="$(check_runs_state "$logs/check-runs-after-dispatch.json")" || fail 'check-runs response after dispatch was malformed or incomplete'
      [ "$check_state" = pass ] || fail "workflow dispatch did not produce passing hosted checks ($check_state)"
    else
      dispatch_error="$logs/dispatch.out"
      cat "$logs/dispatch.log" >> "$dispatch_error"
      if grep -Eq 'HTTP[[:space:]]+422' "$dispatch_error" &&
        grep -Eq 'Actions has been disabled for this repository[.!]?[[:space:]]*(\(HTTP[[:space:]]+422\))?[[:space:]]*$' "$dispatch_error"; then
        hosted_checks='unavailable: Actions disabled by GitHub (422)'
        skipped='Native Windows install'
        local_gate_report="$logs/local-gate-report.json"
        local_status="$logs/local-gate-status"
        assert_source_state 'before local full gate'
        printf 'validation_report=%s\n' "$local_gate_report" > "$local_status" || fail 'could not record local report path'
        write_status running 'hosted Actions disabled; validating with the local full gate' || fail 'could not record local gate status'
        run_checked_command 'local full checks' "$logs/local-full.log" 'local full checks failed' \
          env -u HERMES_HOME -u BROWSER_PARALLEL -u BROWSER_WORKERS -u BROWSER_SCRIPTS -u BROWSER_EXCLUDE \
          CHECK_REPORT="$local_gate_report" BROWSER_RETRY=0 bun run check full
        full_validation_report_has_success "$local_status" "$head" || fail 'local full-check report was missing or invalid'
      else
        fail 'workflow dispatch failed for a reason other than Actions being disabled (HTTP 422)'
      fi
    fi
    ;;
  missing|pending|failed)
    fail "required hosted checks are $check_state for $head"
    ;;
  *)
    fail 'check-runs response had an unknown state'
    ;;
esac

if [ -z "$local_gate_report" ]; then
  run_checked_command 'Integration and browser checks' "$logs/integration-browser.log" 'Integration and browser checks failed' bun run check integration browser
fi

assert_source_state 'release gates'
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
