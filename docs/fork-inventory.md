# Fork realignment inventory

Baseline: upstream `49e76b3e313353694dd39f57e896e7d8f2fd18ab` versus running fork
`0ce93b2d3524f39821615ac00cf46233c398c9fa`. `git diff --no-renames` covers 529 paths:
80 fork additions, 258 modified paths and 191 upstream-only paths absent from the old fork.
181 paths are under `src/`. The text delta is +18,206/-23,396; nine paths are binary.
Upstream-only files are restored upstream features, not fork-only features to preserve.

The new tree starts from upstream, not from a merge of the fork's UI. Supporting code,
translations, screenshots and tests follow each feature's decision. A retained server hunk
never justifies copying the rest of its old file over newer upstream code.

F9b restores only the requested navigation exceptions from `0ce93b2`, on the upstream tree.
Decision totals: **17 keep, 7 drop, 28 take upstream** (52 feature families, not file counts).

| Feature / affected code | Upstream equivalent? | Decision | Reason |
| --- | --- | --- | --- |
| Separate plugin identity, titles, repository and config lookup (`herdr-plugin.toml`, `package.json`, `scripts/plugin.ts`, `index.html`, manifest) | Canonical plugin only | keep | Run `haeminway1.herdr-web-ui` beside the canonical plugin without sharing its config. |
| Listener port 7320 (`shared/protocol.ts`) and existing separate state | Upstream defaults to 7317 | keep | Preserve the existing bridge endpoint and installed clients. |
| Exact Manager identity for GJC/OMO/Codex/Claude (`server/managed-sessions.ts`, protocol and resolver seams) | Native process/store discovery | keep | Provider children must not replace the declared parent; denied identities never fall through to guesses. Transient lookup failures leave the roster pending and propagate sanitized typed errors to conversation reads, preserving displayed chat rather than claiming an empty history. |
| Managed generation-scoped cursors, status discovery and attachment transcript resolution | Native transcript readers | keep | Reuse upstream readers while preventing stale generations and cross-session reads. Read managed history, images and tool output through verified inode-bound descriptors, including inherited Codex segments; a pathname recheck alone cannot authorize the bytes read. |
| Logical GJC choice labels and call/question/managed-binding fences (`gjc-prompt.ts`, `prompt.ts`) | Generic native prompt recognition | keep | Wrapped terminal rows must not become separate or incorrectly answered choices. Unsupported forms stay in the terminal. |
| Bounded Codex metadata header | Smaller generic header assumptions | keep | Current managed Codex headers can be up to 1 MiB including newline; exact ID/cwd/inode checks remain. |
| F6 pinned OMO transcript in a private nonce store (`2aa2907`) | No equivalent | keep | Same-user 0664 files are legitimate only behind the private store and exact inode pin; unsafe files remain denied. |
| F7 SDK single-flight, bounded positive cache and serialized child execution (`5a22a1c`, `3b3edfd`) | Overlapping SDK lookups | keep | Bound CPU/process pressure; verify no more than six spawns per ten seconds and one concurrent child on real panes. |
| Release gate, separate fork version and updater ancestry (`scripts/fork-release.sh`, this inventory, `DEPLOY-FORK.md`) | Canonical release workflow | keep | Explicitly required release path; never tag manually or rewrite running source. |
| Electron application, packaging, preload bridge, icons, tests and documentation (`desktop/`) | Browser-installed PWA | drop | Browser attachments already work; no native shell is required. Do not uninstall the existing laptop application. |
| Electron file-name/path and window hooks (`src/lib/desktop.ts`, tests and call sites) | Browser file upload | drop | Laptop-local paths are not Linux attachments. Upload bytes through upstream's composer. |
| Classic sidebar layout (`ClassicSidebar.*`, `sidebarLayout`) | Workspaces and Agents sidebar | keep | Default to classic; restore the existing fork layout setting so the current upstream sidebar remains selectable. |
| Fork folder/repository grouping (`directoryGroups.*`, `sidebarGrouping`) | Upstream workspace grouping | keep | Restore repository, folder and workspace grouping without replacing upstream pane/tab APIs. |
| Fork sidebar row layout, hover rename/close and version line | Upstream rows and menus | keep | Restore the selected fork row interactions and version footer only. |
| Resident agents, top folders, Resident/Work toggle and launch rows (`residents.*`, `/api/residents`) | Ordinary workspace/agent launch | keep | Restore the local-machine resident store, settings and native launch actions. Preserve user data. |
| Attention inbox and server read state (`NeedsInput.*`, `attention.*`, `pane/seen`) | Upstream status and notifications | keep | Restore waiting, unread and working sections with persistent read state; reading never moves native focus or sends input. |
| Verified manager row pin/lock and its guide/tests | Upstream ordinary pins | keep | Pin only the verified native Manager identity under its ownership root. Client metadata cannot grant a pin; prevent unpin/close/demotion. |
| Opt-in project dashboard (`DashboardSidebar.*`, `dashboardProjects.*`) | Upstream sidebar | drop | Unneeded parallel navigation surface. |
| Instant-send bubbles and outbox (`outbox.*`, composer/chat changes) | Upstream pending follow-ups and draft handling | take upstream | Keep upstream send semantics and recovery, not the fork's duplicate optimistic queue. |
| Composer elapsed/current-tool progress line | Upstream status display | take upstream | No fork-specific composer chrome. |
| Automatic same-card prompt retry (`promptAnswer.*`) | Upstream answer/refusal handling | take upstream | Keep upstream retry UX; retain only server identity fences needed for managed GJC. |
| OMO intent chip (`agentIntent.*`) | Upstream transcript rendering | take upstream | Do not reinterpret narrative text as custom chrome. |
| Runtime notices displayed as fork chrome | Upstream notice rendering | take upstream | Preserve upstream transcript semantics. |
| Touch suggestion chip enabled by default | Upstream suggestion setting | take upstream | No legacy fork default. |
| Folder/branch composer strip hidden by default (`composerStrip`) | Upstream strip | take upstream | Use upstream layout and defaults. |
| Phone transcript's extra 12px margin (`ChatTimeline.css`) | Upstream virtual-list layout | take upstream | No fork-only spacing. |
| Usage meters enabled at the top by default (`usagePlacement`, `showUsage`) | Upstream usage controls | take upstream | Restore upstream placement and defaults. |
| Phone one-line folded usage panel | Upstream usage layout | take upstream | Remove the fork-only compact presentation. |
| Fork Dynamic Island styling and mouse toasts (`Droplet.*`, `AlertToasts.*`) | Upstream notifications | take upstream | Keep upstream notification look and dismissal controls. |
| Connected keyline bloom | No required equivalent | drop | Decorative fork-only effect. |
| Alert-history bell and log (`AlertBell.*`, `alertLog.*`, `pushedAlerts.*`) | Upstream notifications | drop | Extra alert-history subsystem is not required for managed chat. |
| Native push taps restricted to app windows (`notificationTarget.*`, desktop hooks) | Upstream notification navigation | take upstream | Browser-installed app follows upstream navigation. |
| Per-device foreground push suppression (`push/presence`, `presence.*`, `push.*`) | Upstream shared presence policy | take upstream | Do not retain custom push semantics or wire fields. |
| Report palette and default (`styles.css`, palette helpers) | Upstream generated themes | keep | Restore Report only, light/dark, as the default; retain every current upstream theme. Lilac and forest stay removed. Generate all color copies from CSS. Fork-only themes do not get mislabeled in upstream telemetry; their settings snapshot is omitted without changing or deploying the receiver. |
| Alternate Claude/Codex marks (`AgentMark.tsx`, settings) | Upstream marks | take upstream | No fork appearance choices. |
| Single-pane-only default and hidden tab strip | Upstream pane canvas and tabs | take upstream | Restore upstream pane model. |
| Classic pane picker and inline close (`ClassicTabStrip.*`) | Upstream tab menu | take upstream | Remove parallel pane controls and compatibility flags. |
| Terminal history scrollbar hidden | Upstream scrollbar | take upstream | Keep upstream terminal controls. |
| Flat recent-first Panes command palette without groups/status | Upstream grouped palette | take upstream | Restore upstream command navigation. |
| Header plan count/button and Flow/Steps dialog (`PlanDialog.*`, `flowLayout`) | Upstream plan/task presentation | take upstream | Do not resurrect removed plan UI. |
| Plan hidden in background-task chip (`planInChip`) | Upstream plan chip | take upstream | Use upstream default and existing metadata. |
| Phone key-bar order with Ctrl-C last | Upstream customizable key bar | take upstream | Restore upstream defaults. |
| Automatic touch input mode forced to input line | Upstream terminal input mode | take upstream | Keep upstream touch typing behavior. |
| Phone More menu's extra palette/New tab entries | Upstream menu | take upstream | Restore upstream menu; do not restore the already-retired Move pane API. |
| OMO queued-question Working-footer correction (`omo-status.ts`, collector changes) | Upstream status reconciliation | take upstream | Not part of the two retained server fixes; do not port the fork's screen parser or status overrides. |
| Attach startup capability probe filtering | Upstream `AttachStartupProbes` since #1165 | take upstream | The upstream protection already replaces the old fork class. |
| Fresh owned browser fixtures and fork-only UI regression wiring | Upstream isolated check runner and browser suite | take upstream | Keep upstream scenarios and explicitly select their layout; cover the restored default and selected sidebar features on isolated fixtures too. Never capture real managed chat. |
| Retired UI translations and old appearance/screenshots | Upstream dictionaries, docs and media | drop | Restore only active strings for selected features in Korean/Japanese/Chinese. Removed UI leaves no dead strings or old screenshots. |
| Old fork-sync preserve-all-UX prompt and merge-every-feature policy | Explicit upstream rebuild procedure | drop | The superseded policy is retired, not automatic synchronization itself. |
| Automatic fork sync (`scripts/fork-sync.sh`, `scripts/fork-sync-prompt.md`) | Upstream-tag detection and isolated merge worktree | keep | Refresh only a clean deploy/haemin checkout, fail closed on unsafe refresh, and use a read-only dry-run; retain Herdr workspace/agent startup under the new upstream-first policy. Existing external timers are unchanged. |
| Other server/provider changes in modified files | Current upstream provider and security fixes | take upstream | Port only the named retained hunks; keep upstream skill, Claude process-root, file-view, auth and usage behavior. |
| 191 upstream-only paths, newer dependencies, CI, themes, skill menus, file panels and release fragments | Upstream main | take upstream | Keep all of upstream rather than copying the old fork's omissions, lockfile or generated files. |

Provenance: F6 `2aa290786e8ba6ce23f1a168d1d04ed8eb692bfa`; F7 implementation
`5a22a1cd751ea1b62a9a41e74c810b974a5fbecf`, regression follow-up
`3b3edfd1635bb8cb268eb60e335cfbe92134d615`. Baseline comparison is read-only;
this inventory does not claim that release or production acceptance has passed.
