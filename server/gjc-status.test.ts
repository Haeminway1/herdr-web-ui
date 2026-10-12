import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker, type OmoRest } from "./completion.ts";
import { createGjcStatus, gjcTurnAfter } from "./gjc-status.ts";
import { noTurn, OmoStatus, type OmoLine, type OmoPane, type OmoTurn } from "./omo-status.ts";

// records as gjc's native transcript writes them: a message envelope with the pi family's roles
const message = (role: string, stopReason?: string, at = "2026-10-02T00:00:10.000Z", text = "") => JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: at, message: { role, content: [{ type: "text", text }], ...(stopReason ? { stopReason } : {}) } });
// a finished background job's wake, which gjc does not always display
const asyncResult = (display = false) => JSON.stringify({ type: "custom_message", customType: "async-result", display, content: "…", timestamp: "2026-10-02T00:00:20.000Z" });
const bookkeeping = (customType: string) => JSON.stringify({ type: "custom", customType });
const lines = (...entries: string[]) => entries.join("\n") + "\n";
const status = (turn: OmoTurn, entry: string) => gjcTurnAfter(turn, { text: entry });

const root = mkdtempSync(join(tmpdir(), "herdr-gjc-status-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("a GJC turn, read from its transcript", () => {
  it("runs from a prompt through its tool calls, and is over at an answer that stopped for good", () => {
    const reduce = (...entries: string[]) => entries.reduce(status, noTurn());
    expect(reduce(message("user")).status).toBe("working");
    expect(reduce(message("user"), message("assistant", "toolUse")).status).toBe("working");
    expect(reduce(message("user"), message("assistant", "toolUse"), message("toolResult")).status).toBe("working");
    expect(reduce(message("user"), message("assistant", "toolUse"), message("toolResult"), message("assistant", "stop")).status).toBe("idle");
    expect(reduce(message("user"), message("assistant", "length")).status).toBe("idle");
    // the record's timestamp says when the turn's last word was written
    expect(reduce(message("user", undefined, "2026-10-02T00:01:00.000Z")).at).toBe(Date.parse("2026-10-02T00:01:00.000Z"));
  });

  it("is at rest after an error or an abort: no finish (#687)", () => {
    const reduce = (...entries: string[]) => entries.reduce(status, noTurn());
    expect(reduce(message("user"), message("assistant", "error"))).toMatchObject({ status: "idle", failed: true });
    expect(reduce(message("user"), message("assistant", "aborted"))).toMatchObject({ status: "idle", failed: true });
    // a retry that got through finishes the turn after all
    const answered = reduce(message("user"), message("assistant", "error"), message("assistant", "stop"));
    expect([answered.status, answered.failed ?? null]).toEqual(["idle", null]);
    expect(reduce(message("user"), message("assistant", "error"), message("assistant", "toolUse")).status).toBe("working");
  });

  it("keeps the turn an assistant message with a missing or unknown stopReason cannot decide", () => {
    const reduce = (turn: OmoTurn, ...entries: string[]) => entries.reduce(status, turn);
    const unknown = JSON.stringify({ type: "message", timestamp: "2026-10-02T00:00:30.000Z", message: { role: "assistant", content: [], stopReason: "suspended" } });
    const bare = JSON.stringify({ type: "message", timestamp: "2026-10-02T00:00:30.000Z", message: { role: "assistant", content: [] } });
    expect(reduce(noTurn(), unknown, bare).status).toBeNull();
    expect(reduce({ status: "working", at: null, asks: [] }, unknown, bare).status).toBe("working");
    expect(reduce({ status: "idle", at: null, asks: [] }, unknown, bare).status).toBe("idle");
  });

  it("starts a turn on a background job's result, displayed or not, and on no other custom record", () => {
    const reduce = (...entries: string[]) => entries.reduce(status, noTurn());
    const rested = [message("user"), message("assistant", "stop")];
    expect(reduce(...rested, asyncResult()).status).toBe("working");
    expect(reduce(...rested, asyncResult(true)).status).toBe("working");
    // the runtime's own bookkeeping and other agents' wake names are no gjc turn
    for (const note of [bookkeeping("gjc.model_change"), bookkeeping("senpi.hooks.stop-state"),
      JSON.stringify({ type: "custom_message", customType: "omo-senpi:wake", display: false }),
      JSON.stringify({ type: "custom_message", customType: "async-task", display: true }),
      JSON.stringify({ type: "custom_message", content: "no type named" }),
      JSON.stringify({ type: "session", cwd: "/work" }), "not json"]) {
      expect(reduce(...rested, note).status).toBe("idle");
    }
    expect(reduce(bookkeeping("x"), "not json").status).toBeNull();
  });

  it("reads a record of any size by its projected JSON, and only whole lines", () => {
    const big = "x".repeat(200_000);
    const long = message("assistant", "toolUse").replace('"content":[', `"content":[{"type":"thinking","thinking":"${big}"},`);
    const ends: OmoLine = { head: long.slice(0, 4096), tail: long.slice(-4096), record: long };
    expect(gjcTurnAfter(noTurn(), ends).status).toBe("working");
    // the projection truncates long strings but stays complete JSON
    const projected = JSON.parse(long.replace(big, big.slice(0, 64 * 1024)));
    expect(gjcTurnAfter(noTurn(), { head: "", tail: "", record: JSON.stringify(projected) }).status).toBe("working");
    // ends without a projected record say nothing (no regex on text)
    expect(gjcTurnAfter(noTurn(), { head: long.slice(0, 4096), tail: long.slice(-4096) }).status).toBeNull();
    expect(gjcTurnAfter({ status: "working", at: null, asks: [] }, { head: message("assistant", "stop").slice(0, 40), tail: message("assistant", "stop").slice(-40) }).status).toBe("working");
  });
});

describe("a GJC pane's status in place of herdr's provider-child status", () => {
  const pane = (id: string, agent: string | null, status: AgentStatus): HerdrPane => ({ pane_id: id, agent, agent_status: status, cwd: "/work" } as unknown as HerdrPane);
  const snapshotOf = (...panes: HerdrPane[]): SessionSnapshot => ({ panes, agents: panes.map((p) => ({ pane_id: p.pane_id, agent: p.agent, agent_status: p.agent_status })) } as unknown as SessionSnapshot);
  /** herdr follows the provider child: gjc's parent turn can be over while the pane reads working */
  const herdr = () => snapshotOf(pane("gjc", "gjc", "working"), pane("lost", "gjc", "working"), pane("shell", null, "unknown"));
  const FILE = "/s/gjc-session.jsonl";

  function setup(initial = lines(message("user"), message("assistant", "stop"))) {
    const files: Record<string, string> = { [FILE]: initial };
    const ids: Record<string, string> = {};
    const told: ([string, AgentStatus, number, boolean] | [string, AgentStatus, number, boolean, OmoRest])[] = [];
    const found: string[] = [];
    const state = { discovered: new Map<string, OmoPane>([["gjc", { path: FILE, startedAt: null }], ["lost", { path: null, startedAt: null }]]), lookups: 0, clock: 0, failing: false, during: () => {} };
    const gjc = createGjcStatus({
      discover: async () => { state.lookups += 1; state.during(); return new Map(state.discovered); },
      snapshot: async () => herdr(),
      onChange: (id, status, count, turn, rest) => told.push(rest ? [id, status, count, turn, rest] : [id, status, count, turn]),
      onFound: (id) => found.push(id),
      file: {
        stat: (path) => path in files ? { size: Buffer.byteLength(files[path]!), id: ids[path] ?? "1" } : null,
        lines: (path, from, size, each) => { if (state.failing) return from; const text = Buffer.from(files[path]!).subarray(from, size).toString("utf8"); const whole = text.slice(0, text.lastIndexOf("\n") + 1); for (const line of whole.split("\n").slice(0, -1)) each({ text: line }); return from + Buffer.byteLength(whole); },
      },
      now: () => state.clock,
    });
    const append = (...entries: string[]) => { files[FILE] += lines(...entries); };
    /** the file put anew in place of the old one, as a rewrite does */
    const replace = (...entries: string[]) => { files[FILE] = lines(...entries); ids[FILE] = `${Number(ids[FILE] ?? 1) + 1}`; };
    return { gjc, told, found, append, replace, state, files };
  }
  const statuses = (snapshot: SessionSnapshot) => Object.fromEntries(snapshot.panes.map((p) => [p.pane_id, `${p.agent}/${p.agent_status}`]));

  it("reads READY where herdr's provider child still reads working, and no finish from a first idle baseline", async () => {
    const { gjc, told, found } = setup();
    const completions = new CompletionTracker(null);
    const raw = herdr();
    await gjc.refresh(raw.panes);
    // the transcript's final answer is the truth: gjc's turn is over whatever the provider child does
    expect(statuses(gjc.apply(raw))).toEqual({ gjc: "gjc/idle", lost: "gjc/working", shell: "null/unknown" });
    expect([gjc.tracks("gjc"), gjc.tracks("lost"), gjc.runs("lost"), gjc.runs("shell")]).toEqual([true, false, true, false]);
    expect(found.sort()).toEqual(["gjc", "lost"]);
    for (const paneId of found) completions.adopt(paneId, "gjc", []);
    // a pane first known at rest never works, so its idle is no finish and no alert
    expect(told).toEqual([]);
    expect(statuses(completions.present(gjc.apply(raw)))["gjc"]).toBe("gjc/idle");
    // the session that cannot be told keeps herdr's word under the same identity
    expect(statuses(completions.present(gjc.apply(raw)))["lost"]).toBe("gjc/working");
  });

  it("reads RUN while a turn runs and DONE when it ends, in events and in every snapshot", async () => {
    const { gjc, told, append, state } = setup();
    const completions = new CompletionTracker(null);
    const served = () => completions.readSnapshot(async () => { const raw = herdr(); await gjc.refresh(raw.panes); return gjc.apply(raw); });
    await served();
    append(message("user"));
    gjc.poll();
    expect(told).toEqual([["gjc", "working", 0, true]]);
    expect(completions.observe("gjc", "working", "gjc")).toBe("working");
    for (let i = 0; i < 3; i++) { state.clock += 10_000; expect(statuses(await served())["gjc"]).toBe("gjc/working"); }
    append(message("assistant", "toolUse"), message("toolResult"));
    gjc.poll();
    expect(told).toHaveLength(1);
    append(message("assistant", "stop"));
    gjc.poll();
    expect(told.at(-1)).toEqual(["gjc", "idle", 0, true]);
    expect(completions.observe("gjc", "idle", "gjc")).toBe("done");
    for (let i = 0; i < 3; i++) { state.clock += 10_000; expect(statuses(await served())["gjc"]).toBe("gjc/done"); }
    // a finished background job wakes the session: a turn of its own, though gjc displays nothing
    append(asyncResult());
    gjc.poll();
    expect(completions.observe("gjc", told.at(-1)![1], "gjc")).toBe("working");
    expect(statuses(await served())["gjc"]).toBe("gjc/working");
  });

  it("reads READY not DONE for a turn that ended in an error or an abort, and DONE once a retry answers", async () => {
    const { gjc, told, append, state } = setup(lines(message("user"), message("assistant", "toolUse"), message("toolResult")));
    const completions = new CompletionTracker(null);
    const served = () => completions.readSnapshot(async () => { const raw = herdr(); await gjc.refresh(raw.panes); return gjc.apply(raw); });
    await served();
    const shown: AgentStatus[] = [];
    const settle = () => { for (const [id, status, , turn, rest] of told.splice(0)) if (id === "gjc" && turn) shown.push(completions.observe(id, status, "gjc", rest)); };
    append(message("assistant", "error", "2026-10-02T00:01:00.000Z"));
    gjc.poll(); settle();
    expect(shown).toEqual(["working", "idle"]);
    for (let i = 0; i < 3; i++) { state.clock += 10_000; expect(statuses(await served())["gjc"]).toBe("gjc/idle"); }
    // a retry that gets an answer ends the turn after all: that is a finish, alerted as one
    append(message("assistant", "stop", "2026-10-02T00:02:00.000Z"));
    gjc.poll(); settle();
    expect(shown.slice(2)).toEqual(["done"]);
    // an aborted prompt rests the same way; asked and aborted between two polls, only its rest is told
    append(message("user"), message("assistant", "aborted", "2026-10-02T00:03:00.000Z"));
    gjc.poll(); settle();
    expect(shown.slice(3)).toEqual(["idle"]);
    expect(statuses(await served())["gjc"]).toBe("gjc/idle");
  });

  it("leaves herdr's word alone while the transcript is missing, unreadable or holds no turn record", async () => {
    const { gjc, files } = setup();
    const raw = herdr();
    await gjc.refresh(raw.panes);
    expect(gjc.tracks("gjc")).toBe(true);
    // the file vanished: what the pane read before stands until a read says otherwise
    delete files[FILE];
    gjc.poll();
    expect(gjc.tracks("gjc")).toBe(true);
    // a file that was never readable
    const { gjc: blind, told: blindTold, state: blindState } = setup(lines("not json", bookkeeping("gjc.model_change")));
    blindState.discovered.set("gjc", { path: "/s/elsewhere.jsonl", startedAt: null });
    await blind.refresh(raw.panes);
    expect([blind.tracks("gjc"), blind.runs("gjc")]).toEqual([false, true]);
    expect(statuses(blind.apply(raw))["gjc"]).toBe("gjc/working");
    expect(blindTold).toEqual([]);
    // a read that fails leaves herdr's `working` standing, not an idle nobody saw
    blindState.discovered.set("gjc", { path: FILE, startedAt: null });
    blindState.failing = true;
    blindState.clock += 10_000;
    await blind.refresh(raw.panes);
    expect(blind.tracks("gjc")).toBe(false);
    expect(statuses(blind.apply(raw))["gjc"]).toBe("gjc/working");
    expect(blindTold).toEqual([]);
    // an empty file has no turn record either: herdr's word stands
    const { gjc: empty, state: emptyState } = setup("");
    emptyState.discovered.set("gjc", { path: FILE, startedAt: null });
    await empty.refresh(raw.panes);
    expect(empty.tracks("gjc")).toBe(false);
    expect(statuses(empty.apply(raw))["gjc"]).toBe("gjc/working");
  });

  it("does not take an unfinished turn of a process that is gone for a running one", async () => {
    // killed after a tool call, then resumed by a new process without a prompt
    const { gjc, told, state, append } = setup(lines(message("user", undefined, "2026-10-02T00:00:10.000Z"), message("assistant", "toolUse", "2026-10-02T00:00:12.000Z")));
    state.discovered.set("gjc", { path: FILE, startedAt: Date.parse("2026-10-02T00:05:00.000Z") });
    const raw = herdr();
    await gjc.refresh(raw.panes);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/idle");
    // a later lookup that cannot read the start keeps the one read before
    state.discovered.set("gjc", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await gjc.refresh(raw.panes);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/idle");
    expect(told).toEqual([]);
    // a prompt to the new process is a turn
    append(message("user", undefined, "2026-10-02T00:06:00.000Z"));
    gjc.poll();
    expect(told).toEqual([["gjc", "working", 0, true]]);
  });

  it("reads a session the pane switched to from its own start, and lets go when another agent is named", async () => {
    const { gjc, told, files, state } = setup(lines(message("user")));
    const raw = herdr();
    await gjc.refresh(raw.panes);
    expect(told).toEqual([["gjc", "working", 0, true]]);
    // /resume puts a finished session in the pane: its last answer is no new work
    const other = "/s/gjc-other.jsonl";
    files[other] = lines(message("user"), message("assistant", "error", "2026-10-02T00:02:00.000Z"));
    state.discovered.set("gjc", { path: other, startedAt: null });
    state.clock += 10_000;
    await gjc.refresh(raw.panes);
    // an error read from a file found anew is history: it says nothing of a DONE kept since
    expect(told.at(-1)).toEqual(["gjc", "idle", 0, true, "failed-before"]);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/idle");
    // Codex started in the pane: its events are no longer swallowed, and gjc lets go at once
    expect(gjc.named("gjc", "codex")).toBe(true);
    expect(gjc.named("gjc", "codex")).toBe(false);
    expect([gjc.tracks("gjc"), gjc.runs("gjc")]).toEqual([false, false]);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/working");
    // herdr's own name for gjc, and no name, change nothing
    for (const name of [null, "gjc"]) expect(gjc.named("lost", name)).toBe(false);
  });

  it("reads again what a failed read left, and only whole lines of a record still being written", async () => {
    const { gjc, told, append, files, state } = setup(lines(message("user")));
    await gjc.refresh(herdr().panes);
    expect(told).toEqual([["gjc", "working", 0, true]]);
    state.failing = true;
    append(message("assistant", "toolUse"));
    gjc.poll();
    expect(told).toHaveLength(1);
    state.failing = false;
    gjc.poll();
    expect(told).toHaveLength(1);
    // a torn tail waits for its newline: the stop record half-written is not the turn's end yet
    const stop = message("assistant", "stop", "2026-10-02T00:02:00.000Z");
    files[FILE] += stop.slice(0, 60);
    gjc.poll();
    expect(told).toHaveLength(1);
    files[FILE] += stop.slice(60) + "\n";
    gjc.poll();
    expect(told.at(-1)).toEqual(["gjc", "idle", 0, true]);
  });

  it("reads a real transcript file, whole lines at a time and again from where it stopped", async () => {
    const path = join(root, "gjc-session.jsonl");
    writeFileSync(path, lines(message("user"), message("assistant", "toolUse", "2026-10-02T00:00:12.000Z", "x".repeat(200_000))));
    const told: [string, AgentStatus][] = [];
    // no file injection: the shared bounded reader feeds gjc's reducer
    const gjc = createGjcStatus({
      discover: async () => new Map<string, OmoPane>([["gjc", { path, startedAt: null }]]),
      snapshot: async () => herdr(),
      onChange: (id, status) => told.push([id, status]),
    });
    const raw = herdr();
    await gjc.refresh(raw.panes);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/working");
    appendFileSync(path, lines(message("toolResult"), asyncResult(true), message("assistant", "stop", "2026-10-02T00:02:00.000Z")));
    gjc.poll();
    expect(told).toEqual([["gjc", "working"], ["gjc", "idle"]]);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/idle");
  });

  it("keeps the shared tracker's OmO behavior when no GJC options are given", async () => {
    // a default OmoStatus: `omo` identity and aliases, the OmO reducer, an empty file still authoritative
    const omoFiles: Record<string, string> = { [FILE]: "" };
    const told: [string, AgentStatus][] = [];
    const omo = new OmoStatus({
      discover: async () => new Map<string, OmoPane>([["gjc", { path: FILE, startedAt: null }]]),
      snapshot: async () => herdr(),
      onChange: (id, status) => told.push([id, status]),
      file: {
        stat: (path) => path in omoFiles ? { size: Buffer.byteLength(omoFiles[path]!), id: "1" } : null,
        lines: (_path, from) => from,
      },
    });
    const raw = snapshotOf(pane("gjc", "claude", "idle"));
    await omo.refresh(raw.panes);
    expect(omo.tracks("gjc")).toBe(true);
    expect(statuses(omo.apply(raw))["gjc"]).toBe("omo/idle");
    expect(omo.named("gjc", "claude")).toBe(false);
    expect(omo.named("gjc", "codex")).toBe(true);
    expect(told).toEqual([]);
  });
});
