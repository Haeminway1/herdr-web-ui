import { describe, expect, it } from "bun:test";
import { DROPLET_REPEAT_MS, LONG_TURN_MS, dropletAllows, onDroplet, showDroplet, trackTurn, type DropletNotice, type QueuedDroplet } from "./droplet.ts";

const notice: DropletNotice = { machineId: "local", paneId: "p1", agent: "claude", title: "api", machine: null, kind: "blocked" };

describe("dropletAllows", () => {
  it("follows the device's choices, a finished turn's length included", () => {
    expect(dropletAllows({ input: true, done: "off" }, "blocked", null)).toBe(true);
    expect(dropletAllows({ input: false, done: "always" }, "blocked", null)).toBe(false);
    expect(dropletAllows({ input: true, done: "off" }, "done", LONG_TURN_MS)).toBe(false);
    expect(dropletAllows({ input: true, done: "always" }, "done", 1_000)).toBe(true);
    expect(dropletAllows({ input: true, done: "long" }, "done", 1_000)).toBe(false);
    expect(dropletAllows({ input: true, done: "long" }, "done", LONG_TURN_MS)).toBe(true);
    expect(dropletAllows({ input: true, done: "always" }, "working", null)).toBe(false);
  });

  it("tells a long-turn device about a turn it did not see start, as the server does", () => {
    expect(dropletAllows({ input: true, done: "long" }, "done", null)).toBe(true);
  });
});

describe("trackTurn", () => {
  it("measures a turn from the moment the pane started working", () => {
    const started = new Map<string, number>();
    expect(trackTurn(started, "p", "idle", "working", 1_000)).toBeNull();
    expect(trackTurn(started, "p", "working", "done", 71_000)).toBe(70_000);
    expect(started.size).toBe(0);
  });

  it("knows no length for a pane first seen working", () => {
    const started = new Map<string, number>();
    expect(trackTurn(started, "p", undefined, "working", 1_000)).toBeNull();
    expect(trackTurn(started, "p", "working", "done", 2_000)).toBeNull();
  });

  it("counts a wait for the user as part of the turn", () => {
    const started = new Map<string, number>();
    trackTurn(started, "p", "idle", "working", 1_000);
    expect(trackTurn(started, "p", "working", "blocked", 5_000)).toBeNull();
    trackTurn(started, "p", "blocked", "working", 7_000);
    expect(trackTurn(started, "p", "working", "done", 9_000)).toBe(8_000);
  });
});

describe("showDroplet", () => {
  it("is false with nothing to draw it", () => {
    expect(showDroplet(notice, 1)).toBe(false);
  });

  it("hands each notice to the drawer once, and the same one again right away is one notice", () => {
    const seen: QueuedDroplet[] = [];
    const off = onDroplet((n) => seen.push(n));
    try {
      expect(showDroplet(notice, 10_000)).toBe(true);
      expect(showDroplet(notice, 10_000 + DROPLET_REPEAT_MS - 1)).toBe(false);
      expect(showDroplet({ ...notice, kind: "done" }, 10_001)).toBe(true);
      expect(showDroplet(notice, 10_000 + DROPLET_REPEAT_MS)).toBe(true);
      expect(seen.map((n) => n.kind)).toEqual(["blocked", "done", "blocked"]);
      expect(new Set(seen.map((n) => n.id)).size).toBe(3);
    } finally {
      off();
    }
    expect(showDroplet({ ...notice, paneId: "p2" }, 20_000)).toBe(false);
  });
});
