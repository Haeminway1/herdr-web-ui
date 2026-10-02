#!/bin/bash
# Fork release (deploy/haemin, DEPLOY-FORK.md): tags and pushes vX.Y.Z only after every check passes.
#   scripts/fork-release.sh 0.3.4101
# package.json and herdr-plugin.toml must already carry that version. Checks run with the calling
# shell's HERDR_* variables removed (an agent shell inside a herdr pane carries its session's).
#
# typecheck and unit tests must pass outright. An integration or UI failure is accepted only when
# the same check fails the same way on the upstream main this branch merged (a clean worktree of
# it, run here), so a failure upstream already has on this PC cannot block a release, and a new
# one always does:
# - integration: every failing test must also fail upstream (a second run first, for flakes);
# - UI: the suite stops at its first failure, so the same failure upstream is not enough. The run
#   is repeated with only that step taken out (KNOWN_UI_STEPS below), and must then pass whole.
set -uo pipefail
version="${1:?usage: fork-release.sh X.Y.Z}"
root="$(cd "$(dirname "$0")/.." && pwd)"
logs="$(mktemp -d)"
fail() { echo "fork-release: $1 (logs in $logs); nothing tagged" >&2; exit 1; }
for v in $(env | grep -oE '^HERDR_[A-Z_]+'); do unset "$v"; done
export CHROME_PATH="${CHROME_PATH:-/opt/google/chrome/chrome}"
grep -q "\"version\": \"$version\"" "$root/package.json" || fail "package.json is not $version"
grep -q "^version = \"$version\"" "$root/herdr-plugin.toml" || fail "herdr-plugin.toml is not $version"
[ -z "$(git -C "$root" status --porcelain)" ] || fail "the checkout has uncommitted changes"
cd "$root" || exit 1

# A UI step that can fail on a PC for reasons outside this repository, and the sed that takes it out.
# Used only when upstream fails at exactly that step too.
declare -A KNOWN_UI_STEPS=(
  ["Timed out: Control+Shift+ArrowUp leaves the pane"]='s/for (const key of \["Control+Shift+ArrowDown", "Control+Shift+ArrowUp"\])/for (const key of ["Control+Shift+ArrowDown"])/'
)

base=""
baseline() { # a clean worktree of the upstream main this branch merged, made once
  if [ -z "$base" ]; then
    git fetch -q upstream main 2>/dev/null || true
    local commit
    commit="$(git merge-base HEAD upstream/main)" || fail "no upstream/main to compare with"
    base="$logs/upstream"
    git worktree add -q --detach "$base" "$commit" || fail "could not check out upstream $commit"
    (cd "$base" && bun install --frozen-lockfile > "$logs/upstream-install.log" 2>&1) || fail "bun install failed upstream"
    echo "comparing with upstream ${commit:0:7}"
  fi
}
cleanup() { [ -n "$base" ] && git worktree remove --force "$base" 2>/dev/null; }
trap cleanup EXIT
failing() { grep -E '^\(fail\)' "$1" | sed -E 's/ \[[0-9.]+ms\]$//' | sort -u; }
first_error() { grep -m1 -E '^error: ' "$1" | sed 's/^error: //'; }

bun install --frozen-lockfile > "$logs/install.log" 2>&1 || fail "bun install failed"
bun run typecheck > "$logs/typecheck.log" 2>&1 || fail "typecheck failed"
bun run test:unit > "$logs/unit.log" 2>&1 || fail "unit tests failed"

notes=""
if ! bun run test:integration > "$logs/integration.log" 2>&1; then
  bun run test:integration > "$logs/integration-2.log" 2>&1 && mv "$logs/integration-2.log" "$logs/integration.log"
fi
if grep -qE '^\(fail\)' "$logs/integration.log"; then
  baseline
  (cd "$base" && bun run test:integration > "$logs/upstream-integration.log" 2>&1)
  new="$(comm -23 <(failing "$logs/integration.log") <(failing "$logs/upstream-integration.log"))"
  [ -z "$new" ] || fail "integration tests failed that pass upstream: $new"
  notes="$notes; integration failures also upstream: $(failing "$logs/integration.log" | wc -l)"
fi

if ! bun run test:ui > "$logs/ui.log" 2>&1; then
  step="$(first_error "$logs/ui.log")"
  patch="${KNOWN_UI_STEPS[$step]:-}"
  [ -n "$patch" ] || fail "UI regression failed: $step"
  baseline
  (cd "$base" && bun run test:ui > "$logs/upstream-ui.log" 2>&1)
  [ "$(first_error "$logs/upstream-ui.log")" = "$step" ] || fail "UI regression failed where upstream does not: $step"
  cp scripts/ui-regression.ts "$logs/ui-regression.ts.orig"
  sed -i "$patch" scripts/ui-regression.ts
  bun run test:ui > "$logs/ui.log" 2>&1; status=$?
  cp "$logs/ui-regression.ts.orig" scripts/ui-regression.ts
  [ $status -eq 0 ] || fail "UI regression failed with the upstream-failing step taken out: $(first_error "$logs/ui.log")"
  notes="$notes; UI step failing upstream too, taken out: $step"
fi
[ -z "$(git status --porcelain)" ] || fail "the checks left the checkout changed"

echo "all checks passed: unit $(grep -oE '^ *[0-9]+ pass' "$logs/unit.log" | tail -1 | tr -d ' '), ui $(grep -c '^PASS' "$logs/ui.log") PASS, integration $(grep -oE '^ *[0-9]+ pass' "$logs/integration.log" | tail -1 | tr -d ' ')$notes"
git tag "v$version" && git push -q origin HEAD:deploy/haemin "v$version" || fail "tag or push failed"
echo "tagged and pushed v$version"
