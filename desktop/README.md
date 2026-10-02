# herdr desktop

A desktop window for herdr web ui. It opens your server's page as served, so the web ui keeps updating with the server. Around that page the window adds what a browser tab cannot do:

| | Browser tab or installed web app | herdr desktop |
|---|---|---|
| Window closed | No alerts | Stays in the tray (menu bar on a Mac); alerts keep coming |
| Computer restarted | Open it again | Starts at login, in the tray (tray menu → Start at login) |
| Alert | Web push or tab notification | Native notification. A click brings the window forward on that pane |
| Window in front | In-app alert only | In-app alert only. Native notifications come when the window is behind others, minimized or in the tray |
| File dropped, pasted or picked | Uploaded beside the pane; its path goes in | Its own path goes in, and nothing is uploaded |

## Set up

On the first start, give it:
- **Server:** the address of your herdr web ui, as you open it in a browser.
- **File path prefix:** what goes in front of a dropped file's path.
  - Leave it empty when herdr runs on this computer.
  - When herdr is on another computer, put something its agents can fetch the file with. For example, `laptop:` gives `laptop:C:/Users/me/report.pdf`, which `scp` reads as host:path.

Change either one later from the tray menu → **Server and file paths…**.

## Build

```bash
npm install --prefix desktop
npm --prefix desktop start                 # run it from source
npm --prefix desktop run package           # Windows x64, macOS arm64 and x64 into desktop/out/
npm --prefix desktop run package -- win32 x64
```

`desktop/out/<name>` is the whole app: copy the folder and run `herdr.exe` or `herdr.app`. On Windows, the first start adds a Start menu shortcut with the app's ID, without which Windows shows none of its notifications. The server address must be https, or http on this computer. A Mac build copied from another computer needs its ad-hoc signature again: `codesign --force --deep --sign - herdr.app`.

## How it fits the web ui

The page reaches the shell only through `window.herdrDesktop` (`src/lib/desktop.ts`). It has three members:
- `notify` shows an alert.
- `onSelectPane` reports a notification click.
- `nameFiles` names files by their path.

In a browser the object is absent, and nothing changes. `HERDR_DESKTOP_PROFILE=<folder>` keeps a separate profile, for tests or a second shell on another server.

## Tests

```bash
npm --prefix desktop test                  # settings and file naming
bun run build && xvfb-run -a bun desktop/e2e.ts   # the shell on a real server and owned herdr panes
```
