import { expect, it } from "bun:test";
import { forgetGone, recordedIds, sameMessage, type UserTurn } from "./outbox.ts";

it("knows a message by its whole text, spaces aside", () => {
  expect(sameMessage("fix the  bug\nplease", "fix the bug please")).toBe(true);
  expect(sameMessage("yes", "yesterday")).toBe(false);
  expect(sameMessage("a".repeat(300) + "x", "a".repeat(300) + "y")).toBe(false);
});

it("lets each new user turn stand for one message, the oldest first, whatever page holds it", () => {
  const turn = (key: string, text: string): UserTurn => ({ key, text });
  const seen = new Set(["t1", "t2"]);
  const items = [{ id: 1, text: "yes", sent: false, seen }, { id: 2, text: "yes", sent: false, seen }];
  expect([...recordedIds(items, [turn("t1", "yes"), turn("t2", "no"), turn("t3", "yes")])]).toEqual([1]);
  expect([...recordedIds(items, [turn("t1", "yes"), turn("t2", "no"), turn("t3", "yes"), turn("t4", "yes")])].sort()).toEqual([1, 2]);
  // the page moved on: the old turns are gone from it, the new one still counts once
  expect([...recordedIds(items, [turn("t3", "yes")])]).toEqual([1]);
  expect(recordedIds([{ id: 3, text: "no", sent: true, seen }], [turn("t2", "no")]).size).toBe(0);
});

it("retires a message the pane took when the agent recorded it in other words, oldest turn first", () => {
  const turn = (key: string, text: string): UserTurn => ({ key, text });
  const seen = new Set(["t1"]);
  const pasted = { id: 1, text: "line one\nline two\n...", sent: true, seen };
  expect([...recordedIds([pasted], [turn("t1", "old"), turn("t2", "[Pasted text #1 +40 lines]")])]).toEqual([1]);
  // not yet taken by the pane: it waits for its own words
  expect(recordedIds([{ ...pasted, sent: false }], [turn("t2", "[Pasted text #1 +40 lines]")]).size).toBe(0);
  // a word-for-word match is not taken by another message's fallback
  const exact = { id: 2, text: "yes", sent: true, seen };
  expect([...recordedIds([pasted, exact], [turn("t2", "yes"), turn("t3", "[Pasted text]")])].sort()).toEqual([1, 2]);
});

it("forgets what it kept for messages that left the outbox", () => {
  const kept = new Map([[1, new Set(["t1"])], [2, new Set(["t1"])], [3, new Set<string>()]]);
  // 1 was refused and 3 retired; only 2 is still on its way
  forgetGone(kept, [{ id: 2 }]);
  expect([...kept.keys()]).toEqual([2]);
  forgetGone(kept, []);
  expect(kept.size).toBe(0);
});
