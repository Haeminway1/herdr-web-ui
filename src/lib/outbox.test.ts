import { expect, it } from "bun:test";
import { recordedIds, sameMessage, type UserTurn } from "./outbox.ts";

it("knows a message by its whole text, spaces aside", () => {
  expect(sameMessage("fix the  bug\nplease", "fix the bug please")).toBe(true);
  expect(sameMessage("yes", "yesterday")).toBe(false);
  expect(sameMessage("a".repeat(300) + "x", "a".repeat(300) + "y")).toBe(false);
});

it("lets each new user turn stand for one message, the oldest first, whatever page holds it", () => {
  const turn = (key: string, text: string): UserTurn => ({ key, text });
  const seen = new Set(["t1", "t2"]);
  const items = [{ id: 1, text: "yes", seen }, { id: 2, text: "yes", seen }];
  expect([...recordedIds(items, [turn("t1", "yes"), turn("t2", "no"), turn("t3", "yes")])]).toEqual([1]);
  expect([...recordedIds(items, [turn("t1", "yes"), turn("t2", "no"), turn("t3", "yes"), turn("t4", "yes")])].sort()).toEqual([1, 2]);
  // the page moved on: the old turns are gone from it, the new one still counts once
  expect([...recordedIds(items, [turn("t3", "yes")])]).toEqual([1]);
  expect(recordedIds([{ id: 3, text: "no", seen }], [turn("t2", "no")]).size).toBe(0);
});
