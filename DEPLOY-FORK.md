# Fork deployment

Upstream owns design, UX, defaults and dependencies except the kept Fork features below. [The inventory](docs/fork-inventory.md) records dropped and upstream-owned families. Sync starts from a current, clean `deploy/haemin` checkout using `scripts/fork-sync.sh`; its dry-run never writes refs, state or worktrees. A skipped or failed refresh never executes stale sync policy.

## Fork features

- Separate `haeminway1.herdr-web-ui` identity, titles, version and config; loopback port 7320 and separate existing state, independent of the canonical plugin.
- Exact Manager GJC/OMO/Codex/Claude identity, generation-scoped history, status and attachment resolution. Blocked or pending identities never select a provider child or nearby transcript. Recovery metadata alone cannot establish a live GJC session: process birth, boot, cwd, SDK identity, private path and native header must agree. Logical GJC choices remain bound to the current call, question and managed session. Codex headers are bounded to 1 MiB.
- F6 pinned same-user 0664 OMO transcripts only inside the private nonce store; ownership, ID, cwd, inode and replacement checks remain mandatory.
- F7 ten-second SDK listing cache, single-flight and serialized children. Cached rows are candidates only: the installed GJC CLI public `router.SessionRouter.generationStatus` must freshly prove the exact generation without spawning or attaching. Missing, retired or replaced authority fails closed. Strict namespace/record ownership and write checks, including root inode replacement, still apply despite ordinary 0775 project parents. The global queue permits at most six new SDK CLI starts per ten seconds and one concurrent child; a missed deadline remains unidentified.
- Classic sidebar by default with upstream layout selectable, repository/folder/workspace grouping, hover rename/close and version footer; local resident agents, top folders, Resident/Work tabs, `/api/residents` settings and launch; server-verified Manager row pinned/locked without trusting client metadata.
- Attention inbox with waiting, unread and working panes; persistent `/api/pane/seen` read state never changes Herdr focus or sends input. Report light/dark is the default while all upstream themes remain. Report telemetry settings are omitted rather than mislabeled; no receiver deployment.
- Separate version, this policy and `scripts/fork-release.sh` gates. Automatic fork sync remains, but its old preserve-all-UX prompt is retired.

Do not restore Electron, dashboard, outbox, custom push policy, other fork palettes or plan-flow UI. Integrate kept modules through current upstream seams, never replace newer upstream files wholesale. If upstream changes conflict with a kept behavior, stop and ask Haemin in Korean with explicit choices instead of silently discarding either.

## Sync, verification and release

For upstream X.Y.P, choose X.Y.(P*100+n) with positive n above every published fork tag, updating `package.json` and `herdr-plugin.toml` together. Typecheck and focused tests; verify kept UI with an isolated own-state/own-port bridge and headless desktop/phone light/dark screenshots. Never use live native sessions or production :7320 as fixtures. The release gate runs locked dependencies, typecheck, unit, integration and browser checks; report failures honestly.

Automatic upstream sync is preapproved to complete its gated release without further approval: merge the latest `origin/deploy/haemin` into the completed changes, fast-forward the clean deploy/haemin worktree, and run `scripts/fork-release.sh X.Y.Z` only there. Stop and ask Haemin in Korean with options on an impossible kept-feature conflict, failed gate or unsafe fast-forward. Never hand-tag, force-push, bypass gates or run a release from the sync worktree. Installed clients update through the updater: `server/updater.ts` permits installation only when the running revision is an ancestor of the target release; old tags never install and divergent history is blocked. Leave auto-updates disabled on failure; never restart Herdr phase1, panes or native sessions. Discover config with `herdr plugin config-dir haeminway1.herdr-web-ui`; never print or copy credentials.

## Recovery

Fix forward by default. **RETIRED:** `~/.config/herdr-web-ui-fork/updates/393da9f0cd9b4553/rollback-f7.sh` points to pre-realignment 0.4.1104 and is not a rollback route. Only on Haemin's explicit request, a manual previous *installed realigned* release may be selected by repointing the updater's `current.json` with a fork-bridge-only stop, supervisor-lock wait and restart. Verify the selected release and bridge health; do not touch native sessions or turn automatic updates on until acceptance passes.
