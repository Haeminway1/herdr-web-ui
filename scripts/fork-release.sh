#!/bin/bash
# Fork release (deploy/haemin, DEPLOY-FORK.md): tags and pushes vX.Y.Z only after EVERY check passes.
#   scripts/fork-release.sh 0.3.3502
# package.json and herdr-plugin.toml must already carry that version. Checks run with the calling
# shell's HERDR_* variables removed (an agent shell inside a herdr pane carries its session's).
set -uo pipefail
version="${1:?usage: fork-release.sh X.Y.Z}"
root="$(cd "$(dirname "$0")/.." && pwd)"
logs="$(mktemp -d)"
fail() { echo "fork-release: $1 (logs in $logs); nothing tagged" >&2; exit 1; }
for v in $(env | grep -oE '^HERDR_[A-Z_]+'); do unset "$v"; done
grep -q "\"version\": \"$version\"" "$root/package.json" || fail "package.json is not $version"
grep -q "^version = \"$version\"" "$root/herdr-plugin.toml" || fail "herdr-plugin.toml is not $version"
[ -z "$(git -C "$root" status --porcelain)" ] || fail "the checkout has uncommitted changes"
cd "$root" || exit 1
bun install --frozen-lockfile > "$logs/install.log" 2>&1 || fail "bun install failed"
bun run typecheck > "$logs/typecheck.log" 2>&1 || fail "typecheck failed"
bun run test:unit > "$logs/unit.log" 2>&1 || fail "unit tests failed"
CHROME_PATH="${CHROME_PATH:-/opt/google/chrome/chrome}" bun run test:ui > "$logs/ui.log" 2>&1 || fail "UI regression failed"
bun run test:integration > "$logs/integration.log" 2>&1 || fail "integration tests failed"
echo "all checks passed: unit $(grep -oE '^ *[0-9]+ pass' "$logs/unit.log" | tail -1 | tr -d ' '), ui $(grep -c '^PASS' "$logs/ui.log") PASS, integration $(grep -oE '^ *[0-9]+ pass' "$logs/integration.log" | tail -1 | tr -d ' ')"
git tag "v$version" && git push -q origin HEAD:deploy/haemin "v$version" || fail "tag or push failed"
echo "tagged and pushed v$version"
