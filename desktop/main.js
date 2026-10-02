"use strict";
/**
 * herdr desktop: one window on a herdr web ui, kept in the tray.
 *
 * What a browser tab cannot do, and this does:
 * - it stays running when its window is closed (the tray, or the menu bar on a Mac), and
 *   starts with the computer, so alerts come while no window is open;
 * - alerts are native notifications (the page has no web push here, lib/desktop.ts), and a
 *   click brings the window forward on that pane;
 * - files dropped or pasted from the computer are named by their path (preload.js).
 *
 * The page is the web ui as served: it updates with the server, never with this shell.
 */
const path = require("node:path");
const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, shell } = require("electron");
const config = require("./config.js");

const APP_ID = "dev.herdr.desktop";
const configFile = () => path.join(app.getPath("userData"), "config.json");
const iconFile = path.join(__dirname, "icon.png");

// a separate profile (tests, or a second shell on another server): HERDR_DESKTOP_PROFILE=<folder>
if (process.env.HERDR_DESKTOP_PROFILE) app.setPath("userData", process.env.HERDR_DESKTOP_PROFILE);

let settings = config.DEFAULTS;
let win = null;
let tray = null;
let quitting = false;
/** the notification on screen for each pane, so a newer one replaces it */
const shown = new Map();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(start);
}

function start() {
  if (process.platform === "win32") app.setAppUserModelId(APP_ID);
  settings = config.load(configFile());
  applyLoginItem();
  createTray();
  // started at login: in the tray (Windows passes --hidden; a Mac login item says it opened at login)
  const atLogin = process.argv.includes("--hidden") || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin === true);
  registerWindowsShortcut();
  createWindow(atLogin);
}

function createWindow(hidden) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: "herdr",
    icon: iconFile,
    backgroundColor: "#12100e",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // alerts come from the page's event stream: it must keep running while the window is hidden
      backgroundThrottling: false,
    },
  });
  win.once("ready-to-show", () => {
    if (!hidden) win.show();
  });
  // closing the window keeps the app in the tray; Quit (tray menu, Cmd+Q) really quits
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  // a link, and a redirect the server answers with, stay in the window only on the server's origin
  const keepInside = (event, url) => {
    if (sameOrigin(url) || url.startsWith("file:")) return;
    event.preventDefault();
    openOutside(url);
  };
  win.webContents.on("will-navigate", keepInside);
  win.webContents.on("will-redirect", keepInside);
  load();
}

function load() {
  if (!win) return;
  if (settings.url) win.loadURL(settings.url);
  else win.loadFile(path.join(__dirname, "setup.html"));
}

/**
 * Windows shows an app's notifications only for an app with a Start menu shortcut carrying its
 * AppUserModelID: a copied folder has none, so the first start makes it (and keeps it current).
 */
function registerWindowsShortcut() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  const link = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "herdr.lnk");
  const options = { target: process.execPath, appUserModelId: APP_ID, description: "herdr" };
  try {
    const current = shell.readShortcutLink(link);
    if (current.target === process.execPath && current.appUserModelId === APP_ID) return;
    shell.writeShortcutLink(link, "replace", options);
  } catch {
    shell.writeShortcutLink(link, "create", options);
  }
}

function sameOrigin(url) {
  try {
    return settings.url !== "" && new URL(url).origin === new URL(settings.url).origin;
  } catch {
    return false;
  }
}

function openOutside(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") void shell.openExternal(url);
  } catch {
    /* not an address */
  }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const image = nativeImage.createFromPath(iconFile).resize({ width: process.platform === "darwin" ? 18 : 16 });
  tray = new Tray(image);
  tray.setToolTip("herdr");
  tray.on("click", () => showWindow());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open herdr", click: () => showWindow() },
    { label: "Reload", click: () => { load(); showWindow(); } },
    { type: "separator" },
    { label: "Start at login", type: "checkbox", checked: settings.openAtLogin, click: (item) => saveSettings({ ...settings, openAtLogin: item.checked }) },
    { label: "Server and file paths…", click: () => { win?.loadFile(path.join(__dirname, "setup.html")); showWindow(); } },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
}

function applyLoginItem() {
  // not where the OS keeps no login items for a bare binary (Linux): the user's desktop does that
  if (process.platform !== "win32" && process.platform !== "darwin") return;
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: ["--hidden"] });
}

function saveSettings(next) {
  settings = config.save(configFile(), next);
  applyLoginItem();
  refreshTrayMenu();
  return settings;
}

ipcMain.on("herdr:path-prefix", (event) => {
  event.returnValue = settings.pathPrefix;
});

ipcMain.on("herdr:notify", (event, notice) => {
  if (event.sender !== win?.webContents || !sameOrigin(event.senderFrame?.url ?? "")) return;
  if (!Notification.isSupported() || typeof notice?.pane_id !== "string") return;
  // the window in front shows it already; behind other windows, minimized or in the tray it does not
  if (win.isVisible() && win.isFocused() && !win.isMinimized()) return;
  shown.get(notice.tag)?.close();
  const notification = new Notification({ title: notice.title || "herdr", body: notice.body, icon: iconFile });
  notification.on("click", () => {
    showWindow();
    win?.webContents.send("herdr:select-pane", { machine_id: notice.machine_id, pane_id: notice.pane_id });
  });
  notification.on("close", () => {
    if (shown.get(notice.tag) === notification) shown.delete(notice.tag);
  });
  shown.set(notice.tag, notification);
  notification.show();
});

// setup.html: the only page of the shell's own
ipcMain.handle("herdr:get-settings", (event) => (event.senderFrame?.url.startsWith("file:") ? settings : null));
ipcMain.handle("herdr:save-settings", (event, next) => {
  if (!event.senderFrame?.url.startsWith("file:")) return null;
  const saved = saveSettings({ ...settings, ...next });
  if (saved.url) load();
  return saved;
});

app.on("before-quit", () => {
  quitting = true;
});
// the tray keeps it running with every window closed
app.on("window-all-closed", () => {});
app.on("activate", () => showWindow());
