import { afterEach, beforeEach, expect, it, jest } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine, MachineEvent } from "../../shared/machines.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { attentionGroups } from "./attention.ts";
import { SnapshotRequests } from "./snapshotRequests.ts";
import { ReorderCoordinator } from "./workspaceOrder.ts";
import { useRosterEvents } from "./useMachineRoster.ts";

class FakeSource {
  static current: FakeSource;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { FakeSource.current = this; }
  say(payload: MachineEvent): void { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) })); }
  close(): void { this.closed = true; }
}

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of ["EventSource", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeSource });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

async function openRoster() {
  const local = structuredClone(machinesFixture.machines[0]) as Machine;
  local.id = "local";
  const pane = local.snapshot!.panes[0]!;
  pane.agent_status = "done";
  delete pane.attention;
  local.snapshot!.panes = [pane];
  const remote = { ...structuredClone(local), id: "remote" };
  let machines = [local, remote];
  const machinesRef = { current: machines };
  const snapshotRequests = { current: new SnapshotRequests() };
  const noAction = jest.fn(() => {});
  const options: Parameters<typeof useRosterEvents>[0] = {
    locked: false,
    receivePreferencesRef: { current: noAction }, snapshotRequests,
    onRoster: noAction,
    reorderCoordinator: new ReorderCoordinator({ verify: async () => { throw new Error("unexpected boot verification"); } }),
    setMachines: (update) => {
      machines = typeof update === "function" ? update(machines) : update;
      machinesRef.current = machines;
    },
    rosterIn: noAction, setMachineRosterLoaded: noAction, machinesRef,
    onPaneStatus: noAction, onPaneExited: noAction,
    followFocusRef: { current: false },
    selectionRef: { current: { machineId: "local", paneId: pane.pane_id, generation: 0 } },
    splitShownRef: { current: false }, splitRef: { current: null },
    pendingLink: { current: null }, selectionHint: { current: null },
    setSelectedPaneId: noAction, setNotificationViewTarget: noAction,
    setTerminalPeek: noAction, setAutoSelected: noAction, scheduleRefetch: noAction,
    preferencesResubscribedRef: { current: noAction }, preferencesDisconnectedRef: { current: noAction },
    preferencesClosedRef: { current: noAction }, dropIn: noAction, chime: noAction,
    getTakeNotificationTargetRef: () => ({ current: noAction }),
  };
  function Probe() { useRosterEvents(options); return null; }
  await act(async () => { renderer = create(createElement(Probe)); });
  return { machines: () => machines, source: FakeSource.current, paneId: pane.pane_id, noAction, snapshotRequests: snapshotRequests.current };
}

it("applies live attention only to its PC and invalidates an older roster without focusing or sending", async () => {
  const client = await openRoster();
  const before = client.machines();
  const stale = Promise.withResolvers<Machine[]>();
  const commit = jest.fn(() => {});
  const pending = client.snapshotRequests.read(() => stale.promise, commit);
  const attention = { finished_at: "2026-10-23T19:00:00Z", seen_at: null, preview: null };
  await act(async () => {
    client.source.say({ type: "machine-message", machine_id: "local", message: { type: "pane-attention", pane_id: client.paneId, attention } });
  });
  expect(client.machines()[0]!.snapshot!.panes[0]!.attention).toEqual(attention);
  expect(client.machines()[1]).toBe(before[1]!);
  expect(attentionGroups(client.machines()).toRead.map(entry => entry.machine.id)).toEqual(["local"]);
  stale.resolve(before);
  await pending;
  expect(commit).not.toHaveBeenCalled();
  expect(client.noAction).not.toHaveBeenCalled();
  await act(async () => {
    client.source.say({ type: "machine-message", machine_id: "local", message: { type: "pane-attention", pane_id: client.paneId, attention: { ...attention, seen_at: attention.finished_at } } });
  });
  expect(attentionGroups(client.machines()).toRead).toEqual([]);
});

it("ignores unknown PCs and panes and stops receiving attention after unmount", async () => {
  const client = await openRoster();
  const before = client.machines();
  const attention = { finished_at: "2026-10-23T19:00:00Z", seen_at: null, preview: null };
  await act(async () => {
    client.source.say({ type: "machine-message", machine_id: "missing", message: { type: "pane-attention", pane_id: client.paneId, attention } });
  });
  expect(client.machines()).toBe(before);
  await act(async () => {
    client.source.say({ type: "machine-message", machine_id: "local", message: { type: "pane-attention", pane_id: "missing", attention } });
  });
  expect(client.machines()[0]!.snapshot).toBe(before[0]!.snapshot);
  const stopped = client.machines();
  await act(async () => { renderer!.unmount(); });
  renderer = undefined;
  client.source.say({ type: "machine-message", machine_id: "local", message: { type: "pane-attention", pane_id: client.paneId, attention } });
  expect(client.source.closed).toBe(true);
  expect(client.machines()).toBe(stopped);
  expect(client.noAction).not.toHaveBeenCalled();
});
