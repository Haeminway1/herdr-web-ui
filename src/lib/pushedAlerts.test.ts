import { expect, it } from "bun:test";
import { pushedAlert, takePushedAlerts } from "./pushedAlerts.ts";

it("reads what the worker wrote, and nothing else", () => {
  expect(pushedAlert({ at: 5, machineId: "local", paneId: "w1:p1", title: "claude", kind: "blocked" }))
    .toEqual({ at: 5, machineId: "local", paneId: "w1:p1", agent: null, title: "claude", machine: null, kind: "blocked" });
  expect(pushedAlert(null)).toBeNull();
  expect(pushedAlert({ at: 5, machineId: "local", paneId: "w1:p1", title: "claude", kind: "working" })).toBeNull();
  expect(pushedAlert({ at: 9e15, machineId: "local", paneId: "w1:p1", title: "claude", kind: "done" })).toBeNull();
  expect(pushedAlert({ at: 5, machineId: "local", title: "claude", kind: "done" })).toBeNull();
});

it("finds nothing where there is no IndexedDB", async () => {
  expect(await takePushedAlerts(undefined)).toEqual([]);
});
