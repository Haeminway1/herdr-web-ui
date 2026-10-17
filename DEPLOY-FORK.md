# Fork deployment

This fork starts from upstream `main` (`49e76b3` for the 2026-10-18 realignment).
Upstream owns the design, UX, dependencies and browser tests except the selected F9b features below.
The previous preserve-every-fork-feature policy is retired. See the complete decisions in
[docs/fork-inventory.md](docs/fork-inventory.md). Electron is not built or shipped;
[laptop-switch](docs/laptop-switch.md) explains the browser-installed app without uninstalling
anything on the laptop.

## Fork features

- Separate identity: `haeminway1.herdr-web-ui`, fork titles/version/config lookup, loopback
  port 7320 and the existing separate state directory. The canonical plugin stays independent.
- Exact Manager GJC/OMO/Codex/Claude chat identity, generation-scoped history and status/attachment
  resolution. Blocked or pending records never select a provider child or a nearby transcript.
  Recovery metadata is not proof of a live GJC session; process birth, boot, cwd, SDK identity,
  private path and native header must agree. Logical GJC choice answers remain fenced by the
  current call, question and managed binding. Codex headers allow a bounded 1 MiB.
- F6: an exact pinned, same-user OMO transcript may be 0664 only inside its private nonce store.
  Other permissions, ownership, ID/cwd/inode and replacement checks remain enforced.
- F7: ten-second SDK listing cache, single-flight requests and serialized subprocesses. Native
  generation, process and header checks still run per read. Cached rows are only candidates:
  the installed GJC CLI package's public `router.SessionRouter.generationStatus` API must freshly
  prove the exact endpoint generation current, without spawning, attaching or starting sessions.
  Missing, unknown, retired or replaced authority fails closed until a new broker lookup succeeds.
  A GJC installation without this public SDK export cannot authorize cached managed chat.
  Common owner-controlled 0775 project parents do not grant authority:
  the namespace and record retain strict ownership/write checks, and root inode replacement is denied.
  No Manager permissions or files are changed. A global queue spans all agent directories and
  permits at most six new SDK CLI starts per ten seconds (including failures). A lookup that
  cannot reach the next slot within its existing deadline remains unidentified, never stale-ready.
  The release
  acceptance budget is at most six spawns per ten seconds and one concurrent child on real panes.
- F9b: classic sidebar by default, repository/folder/workspace grouping, hover rename/close and
  a version footer. Appearance retains the fork's existing Classic / upstream layout choice.
  Local resident agents, top folders, Resident / Work tabs and launch settings use `/api/residents`.
  A server-verified Herdr Manager row is pinned and locked; ordinary panes sharing its folder
  never acquire that privilege. Stored or client-supplied pin metadata is not authority.
- Attention inbox: waiting for input, unread answers and working panes. `/api/pane/seen` persists
  browser read state without focusing Herdr or sending any input. Report is the default light/dark
  palette; every current upstream theme stays available. Other fork palettes stay removed.
  Report settings are omitted from upstream telemetry rather than mislabeled or requiring a
  receiver deployment. The receiver and its deployed digest remain unchanged.
- This release procedure and its unchanged `scripts/fork-release.sh` gate.

No project dashboard, other fork palette, plan-flow dialog, Electron hook, instant-send/outbox
or custom push policy is retained. Do not replace upstream-owned files with whole old copies;
the restored standalone modules are integrated through current upstream seams.

## Rebuild and release

1. Start a dedicated worktree from the selected upstream `main`. Apply only the features above.
   Bump `package.json` and `herdr-plugin.toml` past every published fork tag (F9b: 0.4.1106).
2. Commit the overlay, with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
   Use `git merge -s ours` to record the running `0ce93b2` as an ancestor without restoring its
   files. Also record the latest `origin/deploy/haemin` (`3b3edfd` after F7), so the gated push
   remains a fast-forward. Never force-push a deployment branch.
3. Run a separate loopback test bridge on 7330 with its own temporary state. Read the real managed
   GJC chat without sending input, taking screenshots or changing native focus; require a ready
   identity and native transcript turns. Probe OMO `w56:p1` read-only: its current expected result
   is `blocked_session_ambiguous`, not a passing native-chat claim. Preserve the exact refusal;
   never rewrite its record, bypass identity checks or select a guessed transcript. Measure only
   SDK children of this test bridge for ten seconds: at most six new children, peak one.
   Verify actual Chromium drag-and-drop upload on an isolated test fixture, not a user's pane.
   Capture fictional desktop 1440×900 and phone 390×844 views in both light and dark, including
   the restored sidebar features and chat, under ignored `_artifacts/f9b-shots/`.
   F9b is a local preflight only: leave the test bridge running, and do not push, tag, deploy,
   run the release script or touch production :7320, Herdr phase1, native sessions or Manager files.
4. Only in a separately authorized release pass, with a clean checkout, run exactly
   `scripts/fork-release.sh 0.4.1106`. The script installs the
   locked dependencies and gates typecheck, unit, integration and browser tests before it tags
   and pushes `HEAD:deploy/haemin` and `v0.4.1106`. Never tag by hand, alter the script to bypass
   a failure, or claim a failed/not-run check passed. Resolve failures before publishing.
5. While automatic updates remain held, use the existing Settings update action or documented
   update API (`POST /api/updates/check`, then `/api/updates/install`, header `X-Herdr-Update: 1`).
   Verify loopback and shared URL health, running revision/version, both real native chat sources,
   attachment behavior and the same ten-second process budget. Do not force-reload clients.
6. Only after production acceptance passes, set `HERDR_WEB_AUTO_UPDATE=1` in the fork plugin's
   existing `.env`. A necessary fork-bridge-only stop/start may load the changed environment;
   repeat acceptance after that restart. Never restart Herdr `phase1`, panes or native sessions.

Config is discovered with `herdr plugin config-dir haeminway1.herdr-web-ui`. Existing production
uses `PORT=7320`, `HOST=127.0.0.1`, its own `HERDR_WEB_STATE_DIR` and existing `CODEX_HOME`.
Never print tokens or copy credentials. Keep automatic updates at 0 on any failure.

## Rollback

Run the existing, shutdown-aware bridge rollback:

```sh
sh ~/.config/herdr-web-ui-fork/updates/393da9f0cd9b4553/rollback-f7.sh
```

It stops only the fork plugin bridge, waits for its supervisor lock to disappear, atomically
restores `current.json` to `release-prompts-0ce93b2`, then starts the bridge again (0.4.1104).
Recheck health and running version; preserve the automatic-update hold until a replacement
passes acceptance. A failed local preflight must not publish a known-bad tag.

An old Manager PTY supervisor can continue projecting stale recovery errors after its source
was fixed. Official read-only `check` and a live-identity `capture` can diagnose this without
restarting native sessions. If an observer rewrites a verified record back to blocked, stop
release acceptance and fix that observer through its owner; never bypass the blocked-record
reader or repeatedly rewrite the record just to obtain a transient passing check.

F9b's read-only preflight first observed OMO `w56:p1` blocked with
`blocked_session_ambiguous`. The native pane then disappeared outside this worktree's fixtures;
its current chat response is exactly `{"source":"scrollback","turns":[]}`. This is not a
successful OMO transcript check. Do not recreate the pane or substitute the new `w56:p2` GJC pane.
