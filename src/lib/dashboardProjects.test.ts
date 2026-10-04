import { expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { dashboardProjects } from "./dashboardProjects.ts";

function machine(id: string, state: Machine["state"], workspaces: string[], panes: [string, string][]): Machine {
  return { id, name: id, kind: "ssh", enabled: true, state, error: null, snapshot: {
    workspaces: workspaces.map((workspace_id) => ({ workspace_id, label: "Same folder" })),
    panes: panes.map(([pane_id, workspace_id]) => ({ pane_id, workspace_id })),
  } as SessionSnapshot };
}

it("preserves server workspace and pane order without merging matching names or machine IDs", () => {
  const projects = dashboardProjects([
    machine("first", "connected", ["z", "a"], [["second", "z"], ["first", "z"], ["third", "a"]]),
    machine("second", "connected", ["z"], [["remote", "z"]]),
  ]);
  expect(projects.map((project) => [project.machine.id, project.workspace.workspace_id, project.panes.map((pane) => pane.pane_id)])).toEqual([
    ["first", "z", ["second", "first"]], ["first", "a", ["third"]], ["second", "z", ["remote"]],
  ]);
  expect(new Set(projects.map((project) => project.key)).size).toBe(3);
});

it("retains empty and offline snapshot workspaces without claiming they are navigable", () => {
  const projects = dashboardProjects([machine("offline", "disconnected", ["empty", "many"], [["one", "many"], ["two", "many"]])]);
  expect(projects.map((project) => [project.online, project.panes.length])).toEqual([[false, 0], [false, 2]]);
  expect(dashboardProjects([{ ...machine("loading", "connecting", [], []), snapshot: null }])).toEqual([]);
});
