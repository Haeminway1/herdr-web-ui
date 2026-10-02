"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const config = require("./config.js");

test("keeps only an http(s) server, a one-line prefix and a yes/no", () => {
  assert.deepEqual(config.sanitize({ url: " https://pc.ts.net:10443/ ", pathPrefix: " laptop: ", openAtLogin: false }), { url: "https://pc.ts.net:10443/", pathPrefix: "laptop:", openAtLogin: false });
  assert.deepEqual(config.sanitize({ url: "file:///etc/passwd", pathPrefix: "a\nb", openAtLogin: "yes" }), { url: "", pathPrefix: "", openAtLogin: true });
  assert.deepEqual(config.sanitize(null), { ...config.DEFAULTS });
  assert.equal(config.parseUrl("http://pc.ts.net:7317/"), "", "plain http only to this computer");
  assert.equal(config.parseUrl("http://127.0.0.1:7317"), "http://127.0.0.1:7317/");
});

test("saves atomically and reads back what it saved, or the defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-desktop-"));
  const file = path.join(dir, "nested", "config.json");
  try {
    assert.deepEqual(config.load(file), { ...config.DEFAULTS });
    config.save(file, { url: "http://localhost:7317", pathPrefix: "" });
    assert.deepEqual(config.load(file), { url: "http://localhost:7317/", pathPrefix: "", openAtLogin: true });
    fs.writeFileSync(file, "{not json");
    assert.deepEqual(config.load(file), { ...config.DEFAULTS });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("names a file by its path, behind the prefix with forward slashes", () => {
  assert.equal(config.nameFile("/Users/me/a b.pdf", ""), "/Users/me/a b.pdf");
  assert.equal(config.nameFile("C:\\Users\\me\\a.pdf", "laptop:"), "laptop:C:/Users/me/a.pdf");
  assert.equal(config.nameFile("C:\\Users\\me\\a.pdf", ""), "C:\\Users\\me\\a.pdf");
  assert.equal(config.nameFile("", "laptop:"), null);
});
