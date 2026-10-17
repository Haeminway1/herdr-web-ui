# Laptop: use the browser-installed app

The Electron shell is no longer built by this fork. Do not uninstall or delete the existing
laptop application. Its server is still Linux; the laptop does not need a local bridge.

## Open and install

1. Save any unsent text from the old window before closing it.
2. In Edge or Chrome, open <https://linux-desktop.tail6e255a.ts.net:10445> while connected to
   the existing tailnet. Confirm the page loads and Settings shows the expected deployed version.
3. In Edge, use **Settings and more → Apps → Install this site as an app**. In Chrome, use
   the address-bar install button or **Cast, save and share → Install page as app**
   (menu wording depends on the browser version).
4. Launch that installed browser app from Start or the taskbar. It uses the same URL and
   upstream UI, without the Electron shell.

Drag a file onto the message box. The browser uploads the file to Linux and inserts its
server attachment reference; this does not require Electron. A laptop-local pathname alone
is not a file available to the Linux agent. Files over the upstream attachment limit are
rejected instead of silently skipped. Review the draft before explicitly sending it.

A new browser profile does not inherit Electron's pairing cookie, settings or unsent drafts.
Keep the old app until the browser is working; do not copy authentication files between profiles.
A bridge update may reconnect the browser, but must never restart the native agent sessions.

## Keep using the old shell temporarily

An old service worker can retain frontend assets from a briefly deployed release even after
the server rolls back. Check the current server version before clearing its cache:
<https://linux-desktop.tail6e255a.ts.net:10445/api/health> must answer successfully, and Settings
must identify the expected running release. The currently deployed release is not implied by
this document's package version.

1. Copy unsent text somewhere safe. Close other Electron windows for this origin.
2. In the remaining shell window, open Developer Tools (usually **Ctrl+Shift+I** or **F12**).
   Open **Application → Service workers** and unregister the worker for
   `https://linux-desktop.tail6e255a.ts.net:10445` only.
3. Under **Application → Cache storage**, delete only this origin's service-worker caches.
   Do not use a blanket clear-storage action: preserve cookies, local/session storage,
   pairing credentials, settings and saved drafts.
4. Close the shell completely, reopen it at the same URL and reload. Confirm the running
   version and that chat loads. If Developer Tools is unavailable in that shell, use the
   fresh Edge/Chrome app above; do not delete the Electron profile as a workaround.

These steps do not uninstall software, change the server URL, rotate credentials, or restart
Herdr, panes or managed conversations.
