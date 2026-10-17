# Fork deployment (deploy/haemin)

This branch runs beside the canonical `devswha.herdr-web-ui` plugin as a second herdr plugin,
`haeminway1.herdr-web-ui`, so the canonical install keeps its own updates, watchdog and alerts.

- Contents: upstream `main` + the open PR branches (merged, never rebased) + this identity overlay
  (plugin id and name, manifest/app title, version, config-dir lookup, this file).
- Plugin config (`herdr plugin config-dir haeminway1.herdr-web-ui`): `PORT=7320`, `HOST=127.0.0.1`,
  `HERDR_WEB_STATE_DIR` = its own state dir, `HERDR_WEB_AUTO_UPDATE=1`, `CODEX_HOME` as the canonical one.
- Releases: plain `vX.Y.Z` tags on the fork only, `patch = upstream patch * 100 + n` (upstream 0.3.34,
  first fork build = v0.3.3401). The built-in updater installs the highest tag that descends from the
  running build. Never push upstream tags to the fork: they would compete with fork numbers.
- Update: merge the new upstream `main` and PR branches here, bump `package.json` and `herdr-plugin.toml`,
  commit, then run `scripts/fork-release.sh X.Y.Z`. It tags and pushes only when typecheck
  passes, and unit, integration and `test:ui` pass or fail only as the merged upstream `main` fails
  on the same PC (it runs that upstream in a clean worktree to compare). Never tag by hand (2026-10-01: a
  hand-written gate checked integration only and shipped v0.3.3501 with a failing unit and UI run).
- When the PRs a release carried have all merged upstream, rebuild instead of merging: start from
  upstream `main`, cherry-pick the overlay, merge the open PR branches, then `git merge -s ours` the
  old `deploy/haemin` so the new build still descends from the running one (2026-10-02, v0.3.4101).
- Fork-only overlay: identity (plugin id, names, version, config-dir lookup), plan meters on at the
  top by default, and the two tests that assume upstream's usage defaults adjusted to match.
- The plugin picks a release up within five minutes; every open app shows its reload banner.
- OMO queued questions do not mark a pane as needing input while its current bottom
  Working footer confirms work. Missing screen evidence or a later dialog keeps INPUT.
- Attach startup capability probes stay out of replay, so a browser reconnect cannot
  answer an old host probe into the pane's shell. Later application output is unchanged.
  (Since v0.4.1001 upstream #1165's `AttachStartupProbes` does this; the fork's own class is gone.)
- Browser release checks use a fresh owned herdr session per run; old failed fixtures
  cannot pollute palette searches or keyboard navigation checks.
- Retire: once the PRs are merged upstream, uninstall this plugin and use the canonical app.

## Fork features (keep working through every sync)

What this build has that upstream does not, or does differently. A sync keeps each one's
user-visible behavior; when upstream reimplements one, its code is taken only if this survives.

Seamless UX is the rule, not a preference: after a sync the user's screens look and work as
before. An upstream redesign of something the user already has (layout, rows, controls, defaults)
is never taken as the new default; it becomes a Settings choice, off by default, and the fork's
look stays. Deleted upstream code the fork's UI still needs is restored, not dropped.
(2026-10-08: v0.4.1 took upstream #521/#556 — workspaces + Agents list, By folder removed — as the
default; the user lost the folder sidebar and the hover rename/close, and v0.4.2 put them back.)

- Chat: instant send (the bubble shows at once, beside upstream's
  pending follow-ups; a send refused over a draft in Claude Code's terminal box comes back to the
  message box with upstream #760's "clear it and send" offer); the work-progress line in the composer status row (elapsed time and current
  tool); a prompt answer refused only because the card's id moved is retried on the same card;
  OmO's lead line as a `.chat-intent` chip and runtime notices as chrome; the suggestion chip on by
  default on touch screens (`suggestionChip`, upstream #1185 made it off; an old `showSuggestionChip:
  false` is honoured); upstream #951's folder and branch strip under the message box is
  `composerStrip` (Settings → Chat → Folder and branch), off by default; a phone's transcript keeps
  its 12px side room inside upstream's virtual list (`ChatTimeline.css`). (2026-10-16, v0.4.1001)
- Sidebar: the classic sidebar by default (`ClassicSidebar.tsx`, `cl-` classes): New session / Add PC
  bar; by default a row per session, its repository folder on top and the session under it, no
  group headers (`sidebarGrouping: "repo"`), or grouped by folder (`directoryGroups.ts`) or workspace;
  each row with agent mark and status; resident agents (`residents.json` in the state dir,
  `/api/residents`, shared/residents.ts): `top` folders above all, then a Resident / Work toggle,
  a dim row that starts a missing resident with the chosen agent/model/effort, 📌 on hover; rename and close on hover, the version line; upstream's
  workspaces + Agents list only as `sidebarLayout: "agents"` (automation browsers default to it
  so upstream's UI tests stay valid; its pins come from upstream #1120's row menu, and the verified
  manager's row leads it with a lock and no menu). The attention inbox above the PCs (Needs you / To read / Working; read state on the
  server, `attention.json`, `pane/seen` proxied for remote PCs; `NeedsInput.tsx`, which upstream
  deleted in #521; a Claude turn held on its background work, upstream's `background_wait` from #534, is
  Working and shows BG, not To read); the opt-in project dashboard sidebar (`dashboardSidebar`).
- Usage: the plan-meter panel at the top of the sidebar (`usagePlacement: "top"`, the fork default,
  with `showUsage` on and palette `report`), folded to one line on a phone.
- Alerts: the Dynamic Island on touch screens and toasts with a mouse (`Droplet.tsx`,
  `AlertToasts`), the connected keyline bloom, the alert-history bell, native push taps routed to
  app windows only.
- Appearance: Claude and Codex mark choices (`claudeMark`, `codexMark`); the six palettes, `report`
  (the fork default) with `lilac` and `forest`, which upstream #1078 cut to three (telemetry reports a
  fork palette as `amber`, the only names its Worker takes).
- Panes: one pane at a time, the tab strip shown only once a workspace has more than one pane, with
  its pane picker and inline close (`ClassicTabStrip.tsx`, `cl-tab-strip` classes), no history
  scrollbar beside the terminal, and the command palette as one Panes list (recent first) with no
  status chips, workspace sections or footer. Upstream #747/#721's herdr-style pane area, tab menu,
  history scrollbar and grouped palette are `tuiPanes` in Settings, off by default (automation
  browsers start on it so upstream's UI tests stay valid). (2026-10-11, v0.4.601)
- Plan: the header's plan button (`done/total`) and its dialog with Flow / Steps (`PlanDialog.tsx`,
  `flowLayout` in `lib/plan.ts`, **Plan flow** and **Plan count in the header**), which upstream #846
  deleted. Its plan inside the composer's background-task chip is `planInChip` in Settings
  ("Plan in the message box"), off by default (automation browsers start on it). (2026-10-12, v0.4.801)
- Terminal: the phone key bar's default order, ^C last (`DEFAULT_KEY_BAR_ITEMS`; upstream #607 put it
  third, reachable through the key bar settings); Terminal input mode → Automatic keeps a touch screen
  on the input line (upstream #1163 starts phones in direct typing; automation starts on upstream's).
- Alerts: the Dynamic Island keeps its look without upstream #1129's close button (a flick puts it away).
- Header: a phone's More menu leads with Command palette and keeps New tab, which upstream #1101
  trimmed (automation browsers keep upstream's menu). Accepted upstream removal (user's choice,
  2026-10-16): Move pane to… with its `/api/pane/move` (#1101). (v0.4.1002)
- Desktop shell (`desktop/`), identity overlay above.
- Managed sessions (v0.4.1102): optional Herdr Manager schema-2 records take precedence
  over provider-child/process guesses for chat and the GJC/OMO status trackers. Both
  sidebars and the composer distinguish identified, pending and blocked identity;
  a verified identity alone never means the engine is ready. Legacy schema-1 records
  are reported as `blocked_record_schema`, not migrated or silently resumed.
- Tests that encode the above: `classic-sidebar-regression.ts`, `needs-input-regression.ts` (re-wired into `ui-regression.ts`),
  the top-panel part of `usage-regression.ts` (it reopens the phone drawer: a closed one is hidden
  since #683), `alert-sound-regression.ts` waiting for the toast.
- Strings: the fork's own UI strings are in every dictionary (ko, ja, zh). Turkish went with upstream
  #1081 in v0.4.1001.
- Web push: a device showing the app holds its own pushes (`/api/push/presence`), beside upstream
  #759's hold of every device while any window is in use.

## Scoped backport and everyday deployment (2026-10-13, v0.4.802)

- Base: `origin/deploy/haemin` at `5bbd0ce` (v0.4.801). Backport only the fixes from
  [OMO #923](https://github.com/devswha/herdr-web-ui/pull/923)
  (`5a9fe391..60967b2`) and [GJC #928](https://github.com/devswha/herdr-web-ui/pull/928)
  (`5a9fe391..cf6e865`), without merging the newer upstream UI or PR branches.
- OMO: custom launchers require live native holder ownership, the process's actual cwd
  (including the OS cwd fallback), and exact binding in their own store. Child GJC,
  Codex or Devin labels cannot replace native OMO ownership. GJC: derive parent turns,
  questions, errors and resumed interruptions from its exact native transcript.
- Keep every fork feature above, the desktop shell and all existing defaults. Both
  new browser scenarios run alongside the existing fork scenarios in the browser lane.
- User preference: after future validated improvements, deploy to the everyday shared
  server endpoint `:10445` used by the Mac mini and laptop by default, and verify both
  devices. An explicit per-task restriction overrides this preference. Preserve native
  sessions, authentication and mappings; never force-reload active clients or restart
  native work sessions. Upstream PR merging is a separate action. Release and device
  verification remain the parent session's responsibility for this backport.

## Automatic sync on each upstream release

`herdr-web-ui-fork-sync.timer` runs `scripts/fork-sync.sh` every five minutes: one `git ls-remote`
of upstream's tags. Only a release tag `deploy/haemin` does not contain starts work: a worktree
`../sync-<tag>` on `sync/upstream-<tag>` with the merge begun, and a herdr workspace
"Web UI 동기화 <tag>" where Claude finishes it from `scripts/fork-sync-prompt.md` (conflicts
resolved keeping the list above, gates, `fork-release.sh`) or asks there when a choice is the
user's. A tag is started once: its state is in `~/.local/state/herdr-web-ui-fork-sync/<tag>`;
delete that file to start it again. `scripts/fork-sync.sh --dry-run` says what a check would do.
