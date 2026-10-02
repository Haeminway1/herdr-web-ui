import { expect, it } from "bun:test";
import { AlertLog, MAX_ENTRIES } from "./alertLog.ts";

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

it("drops what does not look like an entry", () => {
  const data = new Map([["herdr-web-ui:alert-log", JSON.stringify([{ id: 1 }, null, { id: "x", at: 1, paneId: "p", machineId: "local", title: "t", kind: "blocked" }])]]);
  const l = new AlertLog(() => ({ getItem: (k: string) => data.get(k) ?? null, setItem: () => {} }));
  expect(l.read().map((e) => e.id)).toEqual(["x"]);
});
