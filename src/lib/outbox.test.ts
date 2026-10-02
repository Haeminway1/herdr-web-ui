import { expect, it } from "bun:test";
import { recordedIds, sameMessage } from "./outbox.ts";

it("knows a message by its text, spaces aside, and a long one by its first part", () => {
  expect(sameMessage("fix the  bug\nplease", "fix the bug please")).toBe(true);
  expect(sameMessage("yes", "yesterday")).toBe(false);
  expect(sameMessage("a".repeat(500), "a".repeat(300))).toBe(true);
  expect(sameMessage("a".repeat(150), "a".repeat(300))).toBe(false);
});

it("lets each new user turn stand for one message, the oldest first", () => {
  const items = [{ id: 1, text: "yes", baseline: 2 }, { id: 2, text: "yes", baseline: 2 }];
  expect([...recordedIds(items, ["yes", "no", "yes"])]).toEqual([1]);
  expect([...recordedIds(items, ["yes", "no", "yes", "yes"])].sort()).toEqual([1, 2]);
  // a turn from before the message went out is not it
  expect(recordedIds([{ id: 3, text: "no", baseline: 2 }], ["yes", "no"]).size).toBe(0);
  expect(recordedIds([{ id: 4, text: "  ", baseline: 0 }], []).has(4)).toBe(true);
});
