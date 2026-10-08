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

- Chat: native Devin CLI conversations; instant send (the bubble shows at once, beside upstream's
  pending follow-ups); the work-progress line in the composer status row (elapsed time and current
  tool); a prompt answer refused only because the card's id moved is retried on the same card;
  OmO's lead line as a `.chat-intent` chip and runtime notices as chrome.
- Sidebar: the classic sidebar by default (`ClassicSidebar.tsx`, `cl-` classes): New session / Add PC
  bar; by default a row per session, its repository folder on top and the session under it, no
  group headers (`sidebarGrouping: "repo"`), or grouped by folder (`directoryGroups.ts`) or workspace;
  each row with agent mark and status, rename and close on hover, the version line; upstream's
  workspaces + Agents list only as `sidebarLayout: "agents"` (automation browsers default to it
  so upstream's UI tests stay valid). The attention inbox above the PCs (Needs you / To read / Working; read state on the
  server, `attention.json`, `pane/seen` proxied for remote PCs; `NeedsInput.tsx`, which upstream
  deleted in #521); the opt-in project dashboard sidebar (`dashboardSidebar`).
- Usage: the plan-meter panel at the top of the sidebar (`usagePlacement: "top"`, the fork default,
  with `showUsage` on and palette `report`), folded to one line on a phone.
- Alerts: the Dynamic Island on touch screens and toasts with a mouse (`Droplet.tsx`,
  `AlertToasts`), the connected keyline bloom, the alert-history bell, native push taps routed to
  app windows only.
- Appearance: Claude and Codex mark choices (`claudeMark`, `codexMark`).
- Desktop shell (`desktop/`), identity overlay above.
- Tests that encode the above: `classic-sidebar-regression.ts`, `needs-input-regression.ts` (re-wired into `ui-regression.ts`),
  the top-panel part of `usage-regression.ts`, `alert-sound-regression.ts` waiting for the toast.

## Automatic sync on each upstream release

`herdr-web-ui-fork-sync.timer` runs `scripts/fork-sync.sh` every five minutes: one `git ls-remote`
of upstream's tags. Only a release tag `deploy/haemin` does not contain starts work: a worktree
`../sync-<tag>` on `sync/upstream-<tag>` with the merge begun, and a herdr workspace
"Web UI 동기화 <tag>" where Claude finishes it from `scripts/fork-sync-prompt.md` (conflicts
resolved keeping the list above, gates, `fork-release.sh`) or asks there when a choice is the
user's. A tag is started once: its state is in `~/.local/state/herdr-web-ui-fork-sync/<tag>`;
delete that file to start it again. `scripts/fork-sync.sh --dry-run` says what a check would do.
