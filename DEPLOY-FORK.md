# Fork deployment

The fork keeps its separate plugin identity/config/port 7320, Report colors, the existing classic sidebar with residents, grouping, verified Manager pin and attention inbox, and exact managed-session binding. Preserve upstream features unless they conflict with these explicitly retained behaviors; never remove the classic sidebar or a kept feature to resolve a merge. Stop a conflicting candidate and report the concrete conflict instead.

## Automatic sync

`scripts/fork-sync.sh` runs only from a clean `deploy/haemin` checkout. It fast-forwards from `origin/deploy/haemin`, fetches `upstream/main` and compares the actual commit. Each target has a separate candidate worktree and explicit started/failed/validated/contained/released state. Preserve existing merge state and edits; retries reuse the same branch/worktree. A state file or worker exit alone is not validation: verify target ancestry, clean candidate and actual tests.

Automatic sync is authorized only to prepare and validate candidates. Never tag, push, publish, install, deploy or restart services from an automatic sync. Do not change the existing timer/service. The prompt and inventory cannot override the user's retained classic UI. Local candidate validation is not deployment approval.

## Release gate

Keep automatic installation disabled during stabilization, including after an explicitly approved manual deployment. A hidden browser is not notebook Aside acceptance. The user must confirm the separate fake-data preview in the actual notebook Aside, or explicitly instruct the supervising session to deploy that candidate, before production admission.

Use `scripts/fork-release.sh X.Y.Z` only from a clean `deploy/haemin` worktree. First include the latest `origin/deploy/haemin` in the approved candidate's history, deliberately preserving the previewed product source, then fast-forward the deploy worktree. Package and plugin versions must match and exceed published tags. Never reuse withdrawn 0.4.1109.

The release script must pass locked install, Fast checks, Integration and browser checks, plus the exact commit's hosted Fast checks, Integration and browser, and Native Windows install checks. No failed tests, upstream exceptions, missing gates or unsafe fast-forwards may be bypassed. Only the release script creates and atomically pushes the deployment branch/tag. Never hand-tag, move an existing tag or force-push.

Install only the admitted release through the fork updater's manual install API. Verify installed revision, shared health/session, machine connectivity and the existing classic sidebar/scroll behavior. Keep the preceding installed release for rollback. A rollback must also withdraw the faulty release tag from origin and the updater's cached local tags so manual updates do not offer it again; preserve its commit/branch and recovery evidence.

Never restart Herdr itself, phase1, native panes or agents. The canonical service :7317 and its config remain independent. Discover fork config with `herdr plugin config-dir haeminway1.herdr-web-ui`; never print or copy credentials.
