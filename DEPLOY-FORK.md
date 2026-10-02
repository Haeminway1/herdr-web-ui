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
