import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Machine } from "../shared/machines.ts";
import machinesFixture from "../site/demo/fixtures/machines.json";
import recordedPanes from "../site/demo/fixtures/panes.json";

// The filter exercises upstream's two repositories and their linked checkouts. Keep that
// topology local to this test: the fork's other demos retain their independent workspaces.
export const panes = { api: recordedPanes.api, web: recordedPanes.web, flaky: "w1H:p1", omp: "w1J:p1", cli: "w1K:p1", hermes: "w1L:p1", shell: recordedPanes.shell };
const specs = [
  { key: "api", label: "checkout-api", title: "Idempotent payments", agent: "claude", state: "working" },
  { key: "web", label: "export-guard", title: "Guard the export button", agent: "codex", state: "blocked", parent: "api", branch: "feat/export-guard" },
  { key: "flaky", label: "flaky-retry-test", title: "Fix the flaky retry test", agent: "claude", state: "idle", parent: "api", branch: "fix/flaky-retry-test" },
  { key: "omp", label: "cli-tools", title: "Plan the config file", agent: "omp", state: "idle" },
  { key: "cli", label: "retry-flag", title: "Ship the retry flag", agent: "pi", state: "idle", parent: "omp", branch: "feat/retry-flag" },
  { key: "hermes", label: "changelog", title: "Draft the changelog", agent: "hermes", state: "idle", parent: "omp", branch: "docs/changelog" },
  { key: "shell", label: "release", title: "Tag v1.4.0", agent: null, state: "unknown", tabOf: "api" },
] as const;

function fixtureMachines() {
  const machines = structuredClone(machinesFixture) as unknown as { machines: Machine[] };
  const snapshot = machines.machines[0]!.snapshot!;
  const original = structuredClone(snapshot);
  snapshot.panes = [];
  snapshot.agents = [];
  snapshot.workspaces = [];
  snapshot.tabs = [];
  snapshot.layouts = [];
  for (const spec of specs) {
    const paneId = panes[spec.key];
    const workspaceId = spec.key === "shell" ? panes.api.split(":")[0]! : paneId.split(":")[0]!;
    const tabId = `${workspaceId}:t${spec.key === "shell" ? 2 : 1}`;
    const parent = "parent" in spec ? specs.find((candidate) => candidate.key === spec.parent)! : null;
    const cwd = spec.key === "shell" ? "/home/demo/checkout-api" : parent ? `/home/demo/.herdr/worktrees/${parent.label}/${spec.label}` : `/home/demo/${spec.label}`;
    const base = original.panes.find((pane) => pane.pane_id === paneId) ?? original.panes[0]!;
    const pane = { ...structuredClone(base), pane_id: paneId, workspace_id: workspaceId, tab_id: tabId, terminal_id: `${paneId}:term`, label: spec.title, title: spec.title, agent: spec.agent, agent_status: spec.state, agent_session: null, cwd, foreground_cwd: cwd, focused: spec.key === "api" };
    snapshot.panes.push(pane);
    if (spec.agent) snapshot.agents.push({ ...structuredClone(original.agents[0]!), pane_id: paneId, workspace_id: workspaceId, tab_id: tabId, agent: spec.agent, agent_status: spec.state, cwd, foreground_cwd: cwd });
    snapshot.tabs.push({ ...structuredClone(original.tabs[0]!), tab_id: tabId, workspace_id: workspaceId, label: spec.key === "shell" ? "release" : "1", number: spec.key === "shell" ? 2 : 1, focused: spec.key === "api", agent_status: spec.state });
    snapshot.layouts.push({ ...structuredClone(original.layouts[0]!), tab_id: tabId, workspace_id: workspaceId, focused_pane_id: paneId, panes: [{ ...structuredClone(original.layouts[0]!.panes[0]!), pane_id: paneId }], splits: [] });
    if (spec.key !== "shell") snapshot.workspaces.push({ ...structuredClone(original.workspaces[0]!), workspace_id: workspaceId, active_tab_id: tabId, label: spec.label, number: snapshot.workspaces.length + 1, pane_count: spec.key === "api" ? 2 : 1, tab_count: spec.key === "api" ? 2 : 1, focused: spec.key === "api", agent_status: spec.state });
  }
  return machines;
}

const repositorySetup = `for (const workspace of snapshot().workspaces) {
  const pane = snapshot().panes.find((pane) => pane.workspace_id === workspace.workspace_id);
  const spec = SPECS.find((spec) => spec.key === keyOfPane.get(pane?.pane_id ?? ""));
  if (!pane?.cwd || !spec) continue;
  const parentKey = ({ web: "api", flaky: "api", cli: "omp", hermes: "omp" })[spec.key];
  const parent = parentKey ? SPECS.find((candidate) => candidate.key === parentKey) : null;
  const repo = repositoryAt(parent ? "/home/demo/" + parent.label : pane.cwd);
  if (parent) {
    const branch = ({ web: "feat/export-guard", flaky: "fix/flaky-retry-test", cli: "feat/retry-flag", hermes: "docs/changelog" })[spec.key];
    repo.branches.add(branch);
    repo.checkouts.push({ path: pane.cwd, branch, label: spec.label, is_linked_worktree: true, is_bare: false, is_detached: false, is_prunable: false });
  }
  workspace.worktree = worktreeMetadata(repo, pane.cwd);
}`;

/** Only the disposable transport is specialized; the browser always runs the real client. */
export async function buildSidebarFilterTransport(app: string): Promise<void> {
  const repo = join(import.meta.dir, "..");
  const topology = /for \(const workspace of snapshot\(\)\.workspaces\) \{\n  const cwd = snapshot\(\)\.panes\.find\(\(pane\) => pane\.workspace_id === workspace\.workspace_id\)\?\.cwd;\n  if \(cwd\) workspace\.worktree = worktreeMetadata\(repositoryAt\(cwd\)\);\n\}/;
  const built = await Bun.build({
    entrypoints: [join(repo, "site/demo/transport.ts")], outdir: app, naming: "demo-transport.js", target: "browser",
    define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version) },
    plugins: [{ name: "sidebar-filter-fictional-topology", setup(build) {
      build.onLoad({ filter: /site\/demo\/fixtures\/machines\.json$/ }, () => ({ contents: JSON.stringify(fixtureMachines()), loader: "json" }));
      build.onLoad({ filter: /site\/demo\/fixtures\/panes\.json$/ }, () => ({ contents: JSON.stringify(panes), loader: "json" }));
      build.onLoad({ filter: /site\/demo\/fixtures\.ts$/ }, ({ path }) => {
        const source = readFileSync(path, "utf8");
        const declaration = /export const SPECS: DemoSpec\[\] = \[[\s\S]*?\n\];/;
        assert.ok(declaration.test(source), "the demo's spec declaration must be found");
        return { contents: source.replace(declaration, `export const SPECS: DemoSpec[] = ${JSON.stringify(specs)};`), loader: "ts" };
      });
      build.onLoad({ filter: /site\/demo\/transport\.ts$/ }, ({ path }) => {
        const source = readFileSync(path, "utf8");
        assert.ok(topology.test(source), "the demo's repository setup must be found");
        return { contents: source.replace(topology, repositorySetup), loader: "ts" };
      });
    } }],
  });
  assert.ok(built.success, built.logs.map(String).join("\n"));
}
