import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationTurn, SessionSnapshot } from "../shared/protocol.ts";
import { AttentionStore, answerPreview } from "./attention.ts";

/** A store on a clock the test moves. */
function store(file: string | null = null, herdr = "herdr-1") {
  const clock = { now: Date.parse("2026-10-03T10:00:00Z") };
  return { attention: new AttentionStore(file, () => herdr, () => clock.now), clock };
}

const panes = (...list: [string, string][]) => list.map(([pane_id, agent_status]) => ({ pane_id, agent_status }));

describe("AttentionStore", () => {
  it("stamps a finish when work ends at rest, not when it blocks", () => {
    const { attention, clock } = store();
    attention.observe("p", "working");
    expect(attention.observe("p", "blocked")).toBe(false);
    expect(attention.get("p")).toBeNull();
    attention.observe("p", "working");
    clock.now += 60_000;
    expect(attention.observe("p", "done")).toBe(true);
    expect(attention.get("p")).toEqual({ finished_at: "2026-10-03T10:01:00.000Z", seen_at: null, preview: null });
    expect(attention.unread("p")).toBe(true);
    // a plain idle after work is a finish too (an agent finishing in herdr's focused pane)
    attention.observe("q", "working");
    expect(attention.observe("q", "idle")).toBe(true);
    // idle at rest is nothing new
    expect(attention.observe("r", "idle")).toBe(false);
    expect(attention.observe("r", "idle")).toBe(false);
    expect(attention.get("r")).toBeNull();
  });

  it("is read once seen, and to read again after the next finish", () => {
    const { attention, clock } = store();
    attention.observe("p", "working");
    attention.observe("p", "done");
    clock.now += 5_000;
    expect(attention.markSeen("p")?.seen_at).toBe("2026-10-03T10:00:05.000Z");
    expect(attention.unread("p")).toBe(false);
    attention.observe("p", "working");
    clock.now += 5_000;
    attention.observe("p", "done");
    expect(attention.unread("p")).toBe(true);
    expect(attention.get("p")?.seen_at).toBe("2026-10-03T10:00:05.000Z");
    // a pane that never finished has nothing to read
    expect(attention.markSeen("never")).toBeNull();
  });

  it("never puts a read before the finish it reads, whatever the clock did", () => {
    const { attention, clock } = store();
    attention.observe("p", "working");
    attention.observe("p", "done");
    clock.now -= 60_000;
    attention.markSeen("p");
    expect(attention.unread("p")).toBe(false);
  });

  it("counts a pane first seen as done from then, and leaves one with a record alone", () => {
    const { attention } = store();
    expect(attention.baseline(panes(["old", "done"], ["rest", "idle"], ["busy", "working"]))).toEqual(["old"]);
    expect(attention.unread("old")).toBe(true);
    expect(attention.get("rest")).toBeNull();
    attention.markSeen("old");
    // seen once: a later snapshot is no first sight
    expect(attention.baseline(panes(["old", "done"], ["rest", "idle"], ["busy", "working"]))).toEqual([]);
    expect(attention.unread("old")).toBe(false);
    // a snapshot is no transition: it may be older than an event
    attention.observe("busy", "done");
    expect(attention.unread("busy")).toBe(true);
  });

  it("takes a finish no status event told from a snapshot asked for after the last one heard", () => {
    const { attention, clock } = store();
    attention.observe("p", "working");
    const heard = clock.now;
    // a snapshot asked for before that event is older: its idle is no finish
    expect(attention.baseline(panes(["p", "idle"]), heard - 1)).toEqual([]);
    expect(attention.get("p")).toBeNull();
    clock.now += 5_000;
    // herdr's stream never told the idle; the next snapshot does
    expect(attention.baseline(panes(["p", "idle"]), clock.now)).toEqual(["p"]);
    expect(attention.unread("p")).toBe(true);
    // the same snapshot again is nothing new
    expect(attention.baseline(panes(["p", "idle"]), clock.now + 1)).toEqual([]);
  });

  it("drops records of panes gone before the snapshot was asked for", () => {
    const { attention, clock } = store();
    attention.observe("gone", "working");
    attention.observe("gone", "done");
    const askedAt = clock.now + 1;
    clock.now += 2;
    attention.observe("new", "working");
    attention.observe("new", "done");
    attention.baseline(panes(["other", "idle"]), askedAt);
    expect(attention.get("gone")).toBeNull();
    // finished after the snapshot was asked for: the pane may be too new for it
    expect(attention.get("new")).not.toBeNull();
  });

  it("keeps a preview only for the finish it was read for", () => {
    const { attention, clock } = store();
    attention.observe("p", "working");
    attention.observe("p", "done");
    const first = attention.get("p")!.finished_at!;
    attention.observe("p", "working");
    clock.now += 1_000;
    attention.observe("p", "done");
    expect(attention.setPreview("p", first, "old answer")).toBe(false);
    expect(attention.setPreview("p", attention.get("p")!.finished_at!, "new answer")).toBe(true);
    expect(attention.get("p")?.preview).toBe("new answer");
    // the next finish starts without the last one's preview
    attention.observe("p", "working");
    attention.observe("p", "done");
    expect(attention.get("p")?.preview).toBeNull();
  });

  it("puts the read state into the snapshot clients get", () => {
    const { attention } = store();
    attention.observe("p", "working");
    attention.observe("p", "done");
    const snapshot = { panes: [{ pane_id: "p" }, { pane_id: "q" }] } as unknown as SessionSnapshot;
    const decorated = attention.decorate(snapshot);
    expect((decorated.panes[0] as { attention?: unknown }).attention).toEqual(attention.get("p")!);
    expect("attention" in decorated.panes[1]!).toBe(false);
    expect(store().attention.decorate(snapshot)).toBe(snapshot);
  });

  it("keeps the read state across a restart of the same herdr only", () => {
    const dir = mkdtempSync(join(tmpdir(), "attention-"));
    try {
      const file = join(dir, "attention.json");
      const { attention } = store(file);
      attention.observe("p", "working");
      attention.observe("p", "done");
      attention.observe("q", "working");
      attention.observe("q", "done");
      attention.markSeen("q");
      expect(JSON.parse(readFileSync(file, "utf8")).herdr).toBe("herdr-1");

      const restarted = store(file).attention;
      expect(restarted.unread("p")).toBe(true);
      expect(restarted.unread("q")).toBe(false);
      // herdr kept its own done across the restart: no new finish
      expect(restarted.baseline(panes(["p", "done"], ["q", "done"]))).toEqual([]);
      expect(restarted.get("p")).toEqual(attention.get("p"));

      // a herdr started anew reuses pane ids for other panes
      expect(store(file, "herdr-2").attention.get("p")).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("answerPreview", () => {
  const turn = (role: "user" | "assistant", ...parts: ConversationTurn["parts"]): ConversationTurn => ({ role, ts: null, parts });

  it("takes the first line of the last answer, its final answer first", () => {
    expect(answerPreview([
      turn("user", { kind: "text", text: "do it" }),
      turn("assistant", { kind: "text", text: "Looking…", phase: "commentary" }, { kind: "tool", name: "Bash", summary: "", input: "", output: "" }, { kind: "text", text: "\n## **Done**: tests pass\nmore", phase: "final_answer" }),
      turn("user", { kind: "text", text: "next" }),
    ])).toBe("Done: tests pass");
    expect(answerPreview([turn("assistant", { kind: "text", text: "- first point\n- second" })])).toBe("first point");
  });

  it("cuts a long line and has nothing for no answer", () => {
    expect(answerPreview([turn("assistant", { kind: "text", text: "x".repeat(300) })])).toHaveLength(120);
    expect(answerPreview([turn("user", { kind: "text", text: "hi" }), turn("assistant", { kind: "thinking", text: "hmm" })])).toBeNull();
    expect(answerPreview([])).toBeNull();
  });
});
