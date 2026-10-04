import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, WorkspaceInfo } from "../../shared/protocol.ts";

export interface DashboardProject {
  key: string;
  machine: Machine;
  workspace: WorkspaceInfo;
  panes: HerdrPane[];
  online: boolean;
}

/** Snapshot workspace identity and order are authoritative; identical paths are not merged. */
export function dashboardProjects(machines: readonly Machine[]): DashboardProject[] {
  return machines.flatMap((machine) => (machine.snapshot?.workspaces ?? []).map((workspace) => ({
    key: JSON.stringify([machine.id, workspace.workspace_id]),
    machine,
    workspace,
    panes: (machine.snapshot?.panes ?? []).filter((pane) => pane.workspace_id === workspace.workspace_id) as HerdrPane[],
    online: machine.state === "connected",
  })));
}
