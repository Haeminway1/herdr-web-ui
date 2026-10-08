import { expect, test } from "bun:test";

import { DEFAULT_RESIDENTS, launchArgs, residentFolder, sanitizeResidents } from "./residents.ts";

test("a stored or sent list is cleaned: absolute folders once, nothing on top twice, a sane launch", () => {
  expect(sanitizeResidents(null)).toEqual(DEFAULT_RESIDENTS);
  expect(sanitizeResidents({
    top: ["/a/top/", "relative", 3],
    residents: ["/a/one", "/a/one", "/a/top", "/a/two"],
    launch: { kind: "codex", model: "gpt-5.5", effort: "high", extra: true },
  })).toEqual({ top: ["/a/top"], residents: ["/a/one", "/a/two"], launch: { kind: "codex", model: "gpt-5.5", effort: "high" } });
  expect(sanitizeResidents({ launch: { kind: "x", model: "rm -rf /; echo", effort: "max" } }).launch).toEqual(DEFAULT_RESIDENTS.launch);
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
