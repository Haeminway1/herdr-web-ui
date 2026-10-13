import { expect, test } from "bun:test";

import { DEFAULT_RESIDENTS, isSystemResidentPane, launchArgs, normalizeSystemResident, residentFolder, residentName, sanitizeResidents, type SystemResidentPin } from "./residents.ts";

const PIN: SystemResidentPin = { folder: "/a/manager", workspace_id: "w1", pane_id: "w1:p1", terminal_id: "term_1" };

test("a stored or sent list is cleaned: absolute folders once, nothing on top twice, a sane launch", () => {
  expect(sanitizeResidents(null)).toEqual(DEFAULT_RESIDENTS);
  expect(sanitizeResidents({
    top: ["/a/top/", "relative", 3],
    residents: ["/a/one", "/a/one", "/a/top", "/a/two"],
    launch: { kind: "codex", model: "gpt-5.5", effort: "high", extra: true },
  })).toEqual({ top: ["/a/top"], residents: ["/a/one", "/a/two"], launch: { kind: "codex", model: "gpt-5.5", effort: "high" }, names: {}, system_pin: null });
  expect(sanitizeResidents({ launch: { kind: "x", model: "rm -rf /; echo", effort: "max" } }).launch).toEqual(DEFAULT_RESIDENTS.launch);
});

test("a stored or sent system pin is kept only when every field is well formed", () => {
  expect(sanitizeResidents({ system_pin: { ...PIN } }).system_pin).toEqual(PIN);
  expect(sanitizeResidents({ system_pin: { folder: "/a/manager/", workspace_id: " w1 ", pane_id: "w1:p1", terminal_id: "term_1" } }).system_pin).toEqual(PIN);
  for (const bad of [
    { ...PIN, folder: "relative" },
    { ...PIN, folder: "" },
    { ...PIN, workspace_id: "" },
    { ...PIN, pane_id: 3 },
    { folder: "/a/manager", workspace_id: "w1", pane_id: "w1:p1" },
    "w1", 4, [],
  ]) {
    expect(sanitizeResidents({ system_pin: bad }).system_pin).toBeNull();
  }
});

test("a pane belongs to the nearest listed folder at or above its own", () => {
  const folders = ["/home/u/agents", "/home/u/agents/blog"];
  expect(residentFolder("/home/u/agents/blog/src", folders)).toBe("/home/u/agents/blog");
  expect(residentFolder("/home/u/agents", folders)).toBe("/home/u/agents");
  expect(residentFolder("/home/u/agents-old", folders)).toBeNull();
  expect(residentFolder(null, folders)).toBeNull();
});

test("the launch becomes each agent's own flags", () => {
  expect(launchArgs({ kind: "claude", model: "claude-opus-5-5", effort: "medium" })).toEqual(["--model", "claude-opus-5-5", "--effort", "medium"]);
  expect(launchArgs({ kind: "codex", model: "gpt-5.5", effort: "high" })).toEqual(["-m", "gpt-5.5", "-c", "model_reasoning_effort=high"]);
  expect(launchArgs({ kind: "claude", model: "", effort: "" })).toEqual([]);
});

test("a resident keeps the name given to it; one not listed loses it", () => {
  const residents = sanitizeResidents({ top: ["/a/manager"], residents: ["/a/lanes/hls"], names: { "/a/lanes/hls": "  HLS   lane ", "/a/gone": "Gone", "/a/manager": "" } });
  expect(residents.names).toEqual({ "/a/lanes/hls": "HLS lane" });
  expect(residentName(residents, "/a/lanes/hls")).toBe("HLS lane");
  expect(residentName(residents, "/a/manager")).toBe("manager");
});

test("the system pin is normalized first on top and out of the tab, the rest untouched", () => {
  const residents = {
    top: ["/a/first", "/a/manager"],
    residents: ["/a/manager", "/a/lanes/hls"],
    launch: DEFAULT_RESIDENTS.launch,
    names: { "/a/manager": "boss", "/a/lanes/hls": "hls" },
    system_pin: null,
  };
  const normalized = normalizeSystemResident(residents, PIN);
  expect(normalized.top).toEqual(["/a/manager", "/a/first"]);
  expect(normalized.residents).toEqual(["/a/lanes/hls"]);
  expect(normalized.names).toEqual({ "/a/manager": "boss", "/a/lanes/hls": "hls" });
  expect(normalized.system_pin).toEqual(PIN);
  // absent from every list: it joins the top
  expect(normalizeSystemResident(sanitizeResidents({ residents: ["/a/other"] }), PIN).top).toEqual(["/a/manager"]);
  // a null pin clears the field but leaves every list and name alone
  const unpinned = normalizeSystemResident({ ...normalized }, null);
  expect(unpinned.system_pin).toBeNull();
  expect(unpinned.top).toEqual(normalized.top);
  expect(unpinned.residents).toEqual(normalized.residents);
});

test("a pane is the pinned manager only when workspace, pane, terminal and folder all match", () => {
  const pane = { workspace_id: "w1", pane_id: "w1:p1", terminal_id: "term_1", cwd: "/a/manager", label: "anything" };
  expect(isSystemResidentPane(PIN, pane)).toBe(true);
  expect(isSystemResidentPane(null, pane)).toBe(false);
  expect(isSystemResidentPane(undefined, pane)).toBe(false);
  // every id and the exact folder is needed; a look-alike pane is not it
  expect(isSystemResidentPane(PIN, { ...pane, workspace_id: "w2" })).toBe(false);
  expect(isSystemResidentPane(PIN, { ...pane, pane_id: "w1:p2" })).toBe(false);
  expect(isSystemResidentPane(PIN, { ...pane, terminal_id: "term_2" })).toBe(false);
  expect(isSystemResidentPane(PIN, { ...pane, cwd: "/a/manager/sub" })).toBe(false);
  expect(isSystemResidentPane(PIN, { ...pane, cwd: null })).toBe(false);
});
