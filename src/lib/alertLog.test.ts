import { expect, it } from "bun:test";
import { AlertLog, KEY, MAX_ENTRIES, MERGE_MS } from "./alertLog.ts";

function log() {
  const data = new Map<string, string>();
  return { data, log: new AlertLog(() => ({ getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } })) };
}
const entry = (paneId: string, at: number, kind: "blocked" | "done" | "ended" = "blocked") => ({ at, machineId: "local", paneId, agent: "claude", title: paneId, machine: null, kind });

it("keeps the newest first, as many as it keeps, and the same alert twice in a row once", () => {
  const { log: l } = log();
  l.add(entry("a", 1_000));
  l.add(entry("a", 1_500));
  l.add(entry("b", 2_000));
  expect(l.read().map((e) => e.paneId)).toEqual(["b", "a"]);
  for (let i = 0; i < MAX_ENTRIES + 5; i++) l.add(entry(`p${i}`, 10_000 + i * 3_000));
  expect(l.read()).toHaveLength(MAX_ENTRIES);
  expect(l.read()[0]!.paneId).toBe(`p${MAX_ENTRIES + 4}`);
});

it("marks them read, and comes back from storage as it was left", () => {
  const { data, log: l } = log();
  l.add(entry("a", 1_000));
  l.add(entry("b", 5_000), true);
  expect(l.read().map((e) => e.read)).toEqual([true, false]);
  l.markAllRead();
  const again = new AlertLog(() => ({ getItem: (k: string) => data.get(k) ?? null, setItem: () => {} }));
  expect(again.read().map((e) => [e.paneId, e.read])).toEqual([["b", true], ["a", true]]);
  l.clear();
  expect(l.read()).toEqual([]);
});

it("drops what does not look like an entry, or a time it could not show", () => {
  const good = { id: "x", at: 1, paneId: "p", machineId: "local", agent: null, title: "t", machine: null, kind: "blocked", read: false };
  const data = new Map([[KEY, JSON.stringify([
    { id: 1 }, null, good,
    { ...good, id: "no-read", read: undefined },
    { ...good, id: "far", at: 9_000_000_000_000_000 },
    { ...good, id: "nan", at: null },
    { ...good, id: "agent", agent: 7 },
  ])]]);
  const l = new AlertLog(() => ({ getItem: (k: string) => data.get(k) ?? null, setItem: () => {} }));
  expect(l.read().map((e) => e.id)).toEqual(["x"]);
});

it("does not let a repeat the user saw hide one they did not", () => {
  const { log: l } = log();
  l.add(entry("a", 1_000), true);
  l.add(entry("a", 1_500), false);
  expect(l.read().map((e) => [e.paneId, e.read])).toEqual([["a", false]]);
  // the other way round it stays new
  l.add(entry("a", 1_800), true);
  expect(l.read().map((e) => e.read)).toEqual([false]);
});

it("starts each change from what another tab left in storage, and shows it when told", () => {
  const data = new Map<string, string>();
  const storage = () => ({ getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } });
  const one = new AlertLog(storage);
  const two = new AlertLog(storage);
  expect(two.read()).toEqual([]);
  one.add(entry("a", 1_000));
  two.add(entry("b", 5_000));
  expect(two.read().map((e) => e.paneId)).toEqual(["b", "a"]);
  let told = 0;
  one.subscribe(() => { told++; });
  expect(one.read().map((e) => e.paneId)).toEqual(["a"]);
  one.reload();
  expect(told).toBe(1);
  expect(one.read().map((e) => e.paneId)).toEqual(["b", "a"]);
});

it("merges pushes in by time, new, and once when the page heard them too", () => {
  const { log: l } = log();
  l.add(entry("live", 100_000), true);
  l.merge([
    entry("live", 100_000 + MERGE_MS - 1), // the same alert, by push: the clocks differ a little
    entry("missed", 50_000, "done"),
    entry("missed", 50_000, "done"), // the worker wrote it twice
    entry("later", 200_000),
  ]);
  expect(l.read().map((e) => [e.paneId, e.read])).toEqual([["later", false], ["live", true], ["missed", false]]);
  // a real second alert for the pane, well after, is its own entry
  l.merge([entry("live", 100_000 + MERGE_MS)]);
  expect(l.read().filter((e) => e.paneId === "live")).toHaveLength(2);
  // nothing new: nothing written
  const before = l.read();
  l.merge([entry("later", 200_000)]);
  expect(l.read()).toBe(before);
});
