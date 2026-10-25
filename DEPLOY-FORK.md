# Fork deployment

The fork keeps its separate plugin identity/config/port 7320, Report colors, classic sidebar with residents, grouping, verified Manager pin and attention inbox, and exact managed-session binding. Preserve upstream features unless they conflict with these behaviors; never remove the classic sidebar or a kept feature to resolve a merge.

## Automatic sync

`scripts/fork-sync.sh` is a background-only systemd oneshot. It creates no Herdr workspace, pane, terminal or interactive session. The invoked launcher artifact supplies the prompt and policy; `FORK_SYNC_REPO` may point it at an absolute registered `deploy/haemin` worktree. The selected checkout must be clean, then fast-forward from `origin/deploy/haemin` before fetching `upstream/main`.

The global `sync.lock` is acquired before fetch and held through the foreground `gjc -p --mode json --no-pty` worker, so later timer polls coalesce to the latest upstream commit. The worker uses model, provider and effort resolved from the `implement` route, keeps normal tools and subscription credentials, and runs in the deterministic candidate worktree. Each attempt has a private prompt and log under `.local/state/herdr-web-ui-fork-sync` (or `$XDG_STATE_HOME`). Per-target locks and failed-attempt backoff remain in effect.

Each upstream target has a separate candidate worktree and explicit started/failed/validated/contained/released state. Preserve existing merge state, index and edits; retries reuse the same branch/worktree. Validation requires the on-disk JSON report from `bun run check full`, all seven full-gate steps successful, its tested candidate SHA, actual target ancestry and a clean tree. The status stores the absolute report path; worker exit or a status marker alone is not validation. A validated candidate still awaits containment in `deploy/haemin`.

Automatic sync is authorized only to prepare and validate candidates. Never tag, push, publish, install, deploy or restart services from an automatic sync. Keep automatic installation disabled. Local candidate validation is not deployment approval.

The sync change leaves the existing timer and service configuration untouched.

## Release gate

The user must confirm the separate fake-data preview in the actual notebook Aside, or explicitly instruct the supervising session to deploy that candidate, before production admission. A hidden browser is not notebook Aside acceptance.

Use `scripts/fork-release.sh X.Y.Z` only from a clean `deploy/haemin` worktree after approval. First include the latest `origin/deploy/haemin` in the approved candidate's history while deliberately preserving the previewed product source, then fast-forward the deploy worktree. Package and plugin versions must match and exceed published tags. Never reuse withdrawn 0.4.1109.

The release script must pass locked install, Fast checks, Integration and browser checks, plus the exact commit's hosted Fast checks, Integration and browser, and Native Windows install checks. The sole hosted exception is a successful check-runs query that is genuinely empty followed by `workflow_dispatch` failing with HTTP 422 and GitHub's exact “Actions has been disabled for this repository” message; then the script runs `bun run check full` on the unchanged, clean HEAD with an absolute `CHECK_REPORT` outside the checkout and accepts it only after the shared full-report validator confirms every required step and the tested SHA. Status records `hosted_checks=unavailable: Actions disabled by GitHub (422)`, the local report path, and `skipped=Native Windows install`; that Windows installer gate is inapplicable to this Linux-only fork deployment. Every other missing, failed, pending or unreadable hosted result, dispatch error, or invalid local report fails closed. Only the release script creates and atomically pushes the deployment branch/tag. Never hand-tag, move an existing tag or force-push.

Install only the admitted release through the fork updater's manual install API. Verify installed revision, shared health/session, machine connectivity and the existing classic sidebar/scroll behavior. Keep the preceding installed release for rollback. A rollback must also withdraw the faulty release tag from origin and the updater's cached local tags so manual updates do not offer it again; preserve its commit/branch and recovery evidence.

Never restart Herdr itself, phase1, native panes or agents. The canonical service :7317 and its config remain independent. Discover fork config with `herdr plugin config-dir haeminway1.herdr-web-ui`; never print or copy credentials.
