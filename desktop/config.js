"use strict";
/**
 * The shell's own settings, a small JSON file in the app's user data folder:
 *
 * - url: the herdr web ui this window opens (https://..., or http://localhost:...)
 * - pathPrefix: put in front of a dropped file's path, for an agent on another computer
 *   to fetch it from this one (e.g. "laptop:" reads as scp's host:path). Empty when
 *   herdr runs on this computer, so the path is used as it is.
 * - openAtLogin: start with the computer, in the tray
 *
 * Nothing else in the shell keeps state: the web ui keeps its own in the page.
 */
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = Object.freeze({ url: "", pathPrefix: "", openAtLogin: true });

/** plain http only to this computer: anywhere else the page and its traffic could be read or changed on the way */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Only an https address, or http on this computer, is opened; anything else is no address. */
function parseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol === "https:") return url.href;
    if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url.href;
    return "";
  } catch {
    return "";
  }
}

/** A prefix is one short line; a path separator style is the shell's business, not the prefix's. */
function parsePrefix(value) {
  if (typeof value !== "string") return "";
  const prefix = value.trim();
  return prefix.length <= 128 && !/[\r\n]/.test(prefix) ? prefix : "";
}

function sanitize(value) {
  const record = typeof value === "object" && value !== null ? value : {};
  return {
    url: parseUrl(record.url),
    pathPrefix: parsePrefix(record.pathPrefix),
    openAtLogin: typeof record.openAtLogin === "boolean" ? record.openAtLogin : DEFAULTS.openAtLogin,
  };
}

function load(file) {
  try {
    // a file written by Windows tools (PowerShell's UTF8) starts with a byte-order mark JSON refuses
    return sanitize(JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")));
  } catch {
    return { ...DEFAULTS };
  }
}

function save(file, value) {
  const next = sanitize(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(temp, file);
  return next;
}

/**
 * How a dropped file is named for the agent: its path, behind the prefix when there is one.
 * With a prefix the agent reads it from another computer, so Windows' backslashes become
 * slashes, which scp and ssh on Windows take as well.
 */
function nameFile(filePath, prefix) {
  if (typeof filePath !== "string" || filePath === "") return null;
  if (!prefix) return filePath;
  return prefix + filePath.replace(/\\/g, "/");
}

module.exports = { DEFAULTS, sanitize, load, save, nameFile, parseUrl };
