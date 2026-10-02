"use strict";
/**
 * window.herdrDesktop, the page's side of the shell (src/lib/desktop.ts describes it):
 * notify, onSelectPane and nameFiles. The page reaches nothing else of Electron.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const prefix = (() => {
  try {
    const value = ipcRenderer.sendSync("herdr:path-prefix");
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
})();

/** as config.js nameFile: the sandboxed preload cannot require the shell's own files */
function nameFile(filePath) {
  if (typeof filePath !== "string" || filePath === "") return null;
  if (!prefix) return filePath;
  return prefix + filePath.replace(/\\/g, "/");
}

const selectListeners = [];
let pendingSelect = null;
ipcRenderer.on("herdr:select-pane", (_event, target) => {
  if (selectListeners.length === 0) {
    pendingSelect = target;
    return;
  }
  for (const listener of selectListeners) listener(target);
});

const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

contextBridge.exposeInMainWorld("herdrDesktop", {
  notify(notice) {
    if (typeof notice !== "object" || notice === null) return;
    ipcRenderer.send("herdr:notify", {
      title: text(notice.title, 200),
      body: text(notice.body, 500),
      tag: text(notice.tag, 300),
      pane_id: text(notice.pane_id, 200),
      machine_id: text(notice.machine_id, 200) || "local",
    });
  },
  onSelectPane(listener) {
    if (typeof listener !== "function") return;
    selectListeners.push(listener);
    if (pendingSelect) {
      const target = pendingSelect;
      pendingSelect = null;
      listener(target);
    }
  },
  nameFiles(files) {
    if (!Array.isArray(files)) return null;
    const names = [];
    for (const file of files) {
      let filePath = "";
      try {
        filePath = webUtils.getPathForFile(file);
      } catch {
        return null;
      }
      // a file made in the page, or dragged from a browser, has no path: upload it instead
      const name = nameFile(filePath);
      if (name === null) return null;
      names.push(name);
    }
    return names;
  },
});

// the shell's own setup page (setup.html) reads and saves the shell's settings; a served page cannot
if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("herdrSetup", {
    get: () => ipcRenderer.invoke("herdr:get-settings"),
    save: (next) => ipcRenderer.invoke("herdr:save-settings", next),
  });
}
