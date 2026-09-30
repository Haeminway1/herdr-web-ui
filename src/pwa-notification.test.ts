import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Selection = { type: string; pane_id: string; machine_id: string };
type WindowClient = { focused: boolean; postMessage: (data: Selection) => void; focus: () => Promise<void> };

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Execute the shipped worker, including its asynchronous notificationclick listener. */
function notifications(windows: WindowClient[], matchAll = async () => windows) {
  const listeners = new Map<string, (event: unknown) => void>();
  const opened: string[] = [];
  let closed = 0;
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    clients: { matchAll, openWindow: async (url: string) => { opened.push(url); } },
  };
  new Function("self", readFileSync(join(import.meta.dir, "..", "public", "sw.js"), "utf8"))(self);
  const click = (paneId: string | null = "pane-a", machineId = "local"): Promise<void> => {
    let completion!: Promise<void>;
    listeners.get("notificationclick")!({
      notification: { data: { pane_id: paneId, machine_id: machineId }, close: () => { closed++; } },
      waitUntil: (promise: Promise<void>) => { completion = promise; },
    });
    return completion;
  };
  return { click, opened, closed: () => closed };
}

function client(focus = async () => {}, focused = false) {
  const selected: Selection[] = [];
  return { focused, focus, selected, postMessage: (data: Selection) => selected.push(data) };
}

describe("notification clicks", () => {
  it("selects the pane before a delayed focus and repeats after the page resumes", async () => {
    const pending = deferred();
    const target = client(() => pending.promise);
    const worker = notifications([target]);
    const done = worker.click("remote pane/?", "remote&pc");
    await Promise.resolve();
    const selection = { type: "select-pane", pane_id: "remote pane/?", machine_id: "remote&pc" };
    expect(target.selected).toEqual([selection]);
    expect(worker.opened).toEqual([]);
    pending.resolve();
    await done;
    expect(target.selected).toEqual([selection, selection]);
    expect(worker.opened).toEqual([]);
    expect(worker.closed()).toBe(1);
  });

  it("keeps selection on focus rejection and opens the exact remote pane once", async () => {
    const target = client(async () => { throw new Error("NotAllowedError"); });
    const worker = notifications([target]);
    await worker.click("remote pane/?", "remote&pc");
    expect(target.selected).toEqual([{ type: "select-pane", pane_id: "remote pane/?", machine_id: "remote&pc" }]);
    expect(worker.opened).toEqual(["/?machine=remote%26pc&pane=remote%20pane%2F%3F"]);
  });

  it("chooses the focused window and does not open another after a successful focus", async () => {
    const background = client();
    const foreground = client(undefined, true);
    const worker = notifications([background, foreground]);
    await worker.click();
    expect(background.selected).toEqual([]);
    expect(foreground.selected).toHaveLength(2);
    expect(worker.opened).toEqual([]);
  });

  it("opens a pane URL when no app window exists, and root when no pane was supplied", async () => {
    const worker = notifications([]);
    await worker.click("pane-b", "remote");
    await worker.click(null);
    expect(worker.opened).toEqual(["/?machine=remote&pane=pane-b", "/"]);
  });

  it("focuses a generic notification without sending an empty pane selection", async () => {
    let focused = 0;
    const target = client(async () => { focused++; });
    const worker = notifications([target]);
    await worker.click(null);
    expect(focused).toBe(1);
    expect(target.selected).toEqual([]);
    expect(worker.opened).toEqual([]);
  });

  it("a late focus cannot switch away from a more recently tapped notification", async () => {
    const pending = deferred();
    let focuses = 0;
    const target = client(() => ++focuses === 1 ? pending.promise : Promise.resolve());
    const worker = notifications([target]);
    const first = worker.click("pane-a");
    await Promise.resolve();
    await worker.click("pane-b");
    pending.resolve();
    await first;
    expect(target.selected.map((selection) => selection.pane_id)).toEqual(["pane-a", "pane-b", "pane-b"]);
    expect(worker.opened).toEqual([]);
  });

  it("a superseded focus rejection cannot open a stale duplicate window", async () => {
    const pending = deferred();
    let focuses = 0;
    const target = client(() => ++focuses === 1 ? pending.promise : Promise.resolve());
    const worker = notifications([target]);
    const first = worker.click("pane-a");
    await Promise.resolve();
    await worker.click("pane-b");
    pending.reject(new Error("NotAllowedError"));
    await first;
    expect(target.selected.map((selection) => selection.pane_id)).toEqual(["pane-a", "pane-b", "pane-b"]);
    expect(worker.opened).toEqual([]);
  });

  it("a slow client lookup cannot deliver an older tap after the newer one", async () => {
    const pending = deferred();
    let lookups = 0;
    const target = client();
    const worker = notifications([target], async () => {
      if (++lookups === 1) await pending.promise;
      return [target];
    });
    const first = worker.click("pane-a");
    await worker.click("pane-b");
    pending.resolve();
    await first;
    expect(target.selected.map((selection) => selection.pane_id)).toEqual(["pane-b", "pane-b"]);
    expect(worker.opened).toEqual([]);
  });
});
