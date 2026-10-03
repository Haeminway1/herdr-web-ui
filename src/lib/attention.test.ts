import { expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { applyPaneAttention, attentionGroups, isUnread } from "./attention.ts";

const finished = (finished_at: string, seen_at: string | null = null) => ({ finished_at, seen_at, preview: null });

function machine(id: string, panes: HerdrPane[], state: Machine["state"] = "connected"): Machine {
  return { id, name: id, kind: "ssh", enabled: true, state, error: null, snapshot: {
    workspaces: [{ workspace_id: "w", label: "W" }],
    panes: panes.map((pane) => ({ ...pane, workspace_id: "w" })),
  } as SessionSnapshot };
}

it("sorts what needs the user into input, to read (newest first) and working", () => {
  const local = machine("local", [
    { pane_id: "asks", agent_status: "blocked", attention: finished("2026-10-03T09:00:00Z") },
    { pane_id: "older", agent_status: "done", attention: finished("2026-10-03T09:00:00Z") },
    { pane_id: "read", agent_status: "done", attention: finished("2026-10-03T09:00:00Z", "2026-10-03T09:01:00Z") },
    { pane_id: "busy", agent_status: "working", attention: finished("2026-10-03T08:00:00Z") },
    { pane_id: "rest", agent_status: "idle" },
  ] as HerdrPane[]);
  const remote = machine("remote", [
    { pane_id: "newer", agent_status: "idle", attention: finished("2026-10-03T09:30:00Z", "2026-10-03T09:10:00Z") },
  ] as HerdrPane[]);
  const groups = attentionGroups([local, remote]);
  const ids = (list: typeof groups.toRead) => list.map(({ machine, pane }) => `${machine.id}/${pane.pane_id}`);
  expect(ids(groups.needsInput)).toEqual(["local/asks"]);
  expect(ids(groups.toRead)).toEqual(["remote/newer", "local/older"]);
  expect(ids(groups.working)).toEqual(["local/busy"]);
});

it("leaves offline PCs and panes without a finish out", () => {
  const offline = machine("offline", [{ pane_id: "p", agent_status: "done", attention: finished("2026-10-03T09:00:00Z") }] as HerdrPane[], "disconnected");
  const plain = machine("plain", [{ pane_id: "p", agent_status: "done" }] as HerdrPane[]);
  expect(attentionGroups([offline, plain])).toEqual({ needsInput: [], toRead: [], working: [] });
});

it("is unread only at rest, after a finish newer than the last read", () => {
  expect(isUnread({ pane_id: "p", agent_status: "done", attention: finished("2026-10-03T09:00:00Z") } as HerdrPane)).toBe(true);
  expect(isUnread({ pane_id: "p", agent_status: "unknown", attention: finished("2026-10-03T09:00:00Z", "2026-10-03T08:00:00Z") } as HerdrPane)).toBe(true);
  expect(isUnread({ pane_id: "p", agent_status: "done", attention: finished("2026-10-03T09:00:00Z", "2026-10-03T09:00:00Z") } as HerdrPane)).toBe(false);
  expect(isUnread({ pane_id: "p", agent_status: "blocked", attention: finished("2026-10-03T09:00:00Z") } as HerdrPane)).toBe(false);
  expect(isUnread({ pane_id: "p", agent_status: "done" } as HerdrPane)).toBe(false);
});

it("merges a pushed read state, and keeps the snapshot when nothing changed", () => {
  const snapshot = machine("m", [{ pane_id: "p", agent_status: "done" }] as HerdrPane[]).snapshot!;
  const state = finished("2026-10-03T09:00:00Z", "2026-10-03T09:05:00Z");
  const next = applyPaneAttention(snapshot, "p", state);
  expect((next.panes[0] as HerdrPane).attention).toEqual(state);
  expect(applyPaneAttention(next, "p", { ...state })).toBe(next);
  expect(applyPaneAttention(next, "other", state)).toBe(next);
});
