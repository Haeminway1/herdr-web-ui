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
- Update: merge the new upstream `main` and PR branches here, run typecheck, unit, `test:ui` and
  `test:integration` in an isolated herdr session, bump `package.json` and `herdr-plugin.toml`, tag,
  push. The plugin picks it up within five minutes; every open app shows its reload banner.
- Retire: once the PRs are merged upstream, uninstall this plugin and use the canonical app.
