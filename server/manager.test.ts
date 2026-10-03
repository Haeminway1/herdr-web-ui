import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../shared/herdr-api.generated.ts";
import { createServer } from "./index.ts";
import { createManager } from "./manager.ts";
import { DeviceStore } from "./devices.ts";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(watchDevice = false) {
  const root = mkdtempSync(join(tmpdir(), "herdr-manager-test-"));
  roots.push(root);
  const store = watchDevice ? new DeviceStore(root) : null;
  const watch = store?.pair(store.startPairing().code, "Watch", "watch");
  let snapshot = { workspaces: [], panes: [], agents: [] } as unknown as SessionSnapshot;
  let launches = 0;
  let closes = 0;
  let fail = false;
  let outage = false;
  let holdStart: Promise<void> | undefined;
  let args: string[] | undefined;
  let kind: string | undefined;
  const api = {
    snapshot: async () => { if (outage) throw Error("snapshot unavailable"); return snapshot; },
    manifests: async () => ({ manifests: [{ agent: "codex" }, { agent: "claude" }] }) as Awaited<ReturnType<typeof import("./herdr/client.ts").agentManifests>>,
    create: async ({ cwd, label }: { cwd?: string; label?: string }) => {
      snapshot = { ...snapshot, workspaces: [{ workspace_id: "w", label }], panes: [{ pane_id: "p", workspace_id: "w", cwd, agent: null }] } as SessionSnapshot;
      return { workspace: { workspace_id: "w" }, root_pane: { pane_id: "p" } } as Awaited<ReturnType<typeof import("./herdr/client.ts").workspaceCreate>>;
    },
    report: async (paneId: string, token: string) => { snapshot = { ...snapshot, panes: [{ ...snapshot.panes[0]!, tokens: { manager_identity: token } }] }; },
    start: async (options: { kind?: string; args?: string[] }) => { launches++; args = options.args; kind = options.kind; if (holdStart) await holdStart; if (fail) throw Error("launch failed"); snapshot = { ...snapshot, panes: [{ ...snapshot.panes[0]!, agent: kind }], agents: [{ pane_id: "p", name: "herdr-resident-manager", agent: kind }] } as SessionSnapshot; },
    close: async () => { closes++; snapshot = { ...snapshot, panes: [], workspaces: [] }; },
  };
  const manager = createManager(root, api as Parameters<typeof createManager>[1]);
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "secret", stateDir: root, manager });
  servers.push(server);
  const url = `http://127.0.0.1:${server.port}`;
  const request = (path: string, body?: object, token = "secret", origin = url) => fetch(url + path, {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, origin, "content-type": "application/json" }, body: body && JSON.stringify(body),
  });
  return { request, root, api, watch, get snapshot() { return snapshot; }, set snapshot(value: SessionSnapshot) { snapshot = value; }, get launches() { return launches; }, get args() { return args; }, get closes() { return closes; }, set fail(value: boolean) { fail = value; }, set outage(value: boolean) { outage = value; }, set holdStart(value: Promise<void> | undefined) { holdStart = value; } };
}

it("auth and origin gate manager routes", async () => {
  const f = fixture();
  expect((await f.request("/api/manager", undefined, "bad")).status).toBe(401);
  expect((await f.request("/api/manager/start", { agent: "codex" }, "bad")).status).toBe(401);
  expect((await f.request("/api/manager/start", { agent: "codex" }, "secret", "https://evil.example")).status).toBe(403);
  expect(f.launches).toBe(0);
});

it("starts one native agent, reuses it under concurrent starts, and stops only exact live identity", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.request("/api/manager/start", { agent: "codex" }), f.request("/api/manager/start", { agent: "codex" })]);
  expect(await a.json()).toMatchObject({ state: "running", workspace_id: "w", pane_id: "p" });
  expect(await b.json()).toMatchObject({ state: "running", workspace_id: "w", pane_id: "p" });
  expect(f.launches).toBe(1);
  f.snapshot = { ...f.snapshot, workspaces: [{ ...f.snapshot.workspaces[0]!, label: "renamed by user" }] };
  expect(await (await f.request("/api/manager")).json()).toMatchObject({ state: "running", pane_id: "p" });
  expect(await (await f.request("/api/manager/start", { agent: "codex" })).json()).toMatchObject({ state: "running", pane_id: "p" });
  expect(f.launches).toBe(1);
  expect(await (await f.request("/api/manager/stop", { workspace_id: "w", pane_id: "stale" })).json()).toMatchObject({ state: "ambiguous" });
  expect(f.closes).toBe(0);
  expect(await (await f.request("/api/manager/stop", { workspace_id: "w", pane_id: "p" })).json()).toMatchObject({ state: "stopped" });
  expect(f.closes).toBe(1);
  expect(await (await f.request("/api/manager/start", { agent: "codex" })).json()).toMatchObject({ state: "running" });
  expect(f.launches).toBe(2);
});

it("fails closed on ambiguity, unsupported options, and launch failure without cleanup", async () => {
  const f = fixture();
  expect(await (await f.request("/api/manager/start", { agent: "codex", model: "--evil" })).json()).toMatchObject({ state: "unavailable" });
  expect(await (await f.request("/api/manager/start", { agent: "unknown" })).json()).toMatchObject({ state: "unavailable" });
  expect(f.launches).toBe(0);
  f.fail = true;
  expect(await (await f.request("/api/manager/start", { agent: "codex" })).json()).toMatchObject({ state: "unavailable", pane_id: "p" });
  expect(f.closes).toBe(0);
  f.snapshot = { ...f.snapshot, workspaces: [...f.snapshot.workspaces, { ...f.snapshot.workspaces[0]!, workspace_id: "other" }] };
  expect(await (await f.request("/api/manager")).json()).toMatchObject({ state: "ambiguous" });
  expect(await (await f.request("/api/manager/stop", { workspace_id: "w", pane_id: "p" })).json()).toMatchObject({ state: "ambiguous" });
  expect(f.closes).toBe(0);
});

it("passes safe native model and effort arguments and rejects missing or forged identity", async () => {
  const f = fixture();
  expect(await (await f.request("/api/manager/start", { agent: "codex", model: "gpt-5", effort: "high" })).json()).toMatchObject({ state: "running" });
  expect(f.args).toEqual(["--model", "gpt-5", "-c", 'model_reasoning_effort="high"']);
  const pane = f.snapshot.panes[0]!;
  f.snapshot = { ...f.snapshot, agents: [{ ...f.snapshot.agents[0]!, agent: "claude" }] };
  expect(await (await f.request("/api/manager")).json()).toMatchObject({ state: "ambiguous" });
  f.snapshot = { ...f.snapshot, agents: [{ ...f.snapshot.agents[0]!, agent: "codex" }], panes: [{ ...pane, agent: "claude" }] };
  expect(await (await f.request("/api/manager")).json()).toMatchObject({ state: "ambiguous" });
  f.snapshot = { ...f.snapshot, panes: [{ ...pane, tokens: {} }] };
  expect(await (await f.request("/api/manager")).json()).toMatchObject({ state: "ambiguous" });
  expect(await (await f.request("/api/manager/stop", { workspace_id: "w", pane_id: "p" })).json()).toMatchObject({ state: "ambiguous" });
  expect(f.closes).toBe(0);
});

it("passes supported Claude effort arguments without changing the requested model", async () => {
  const f = fixture();
  expect(await (await f.request("/api/manager/start", { agent: "claude", model: "opus", effort: "medium" })).json()).toMatchObject({ state: "running", pane_id: "p" });
  expect(f.args).toEqual(["--model", "opus", "--effort", "medium"]);
  expect(await (await f.request("/api/manager/start", { agent: "claude" })).json()).toMatchObject({ state: "running", pane_id: "p" });
  expect(f.launches).toBe(1);
  expect(f.closes).toBe(0);
});

it("keeps lifecycle HTTP open beyond Bun's default ten-second idle timeout", async () => {
  const f = fixture();
  const start = f.api.start;
  f.api.start = async (options: { kind?: string; args?: string[] }) => {
    await Bun.sleep(10_200);
    return start(options);
  };
  const response = await f.request("/api/manager/start", { agent: "claude" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ state: "running", workspace_id: "w", pane_id: "p" });
  expect(f.launches).toBe(1);
}, 20_000);

it("keeps guidance in its private directory without starting until explicitly requested", async () => {
  const f = fixture();
  expect(await (await f.request("/api/manager")).json()).toMatchObject({ state: "absent" });
  expect(f.launches).toBe(0);
  expect(await (await f.request("/api/manager/start", { agent: "codex" })).json()).toMatchObject({ state: "running" });
  const guidance = readFileSync(join(f.root, "manager", "AGENTS.md"), "utf8");
  expect(readFileSync(join(f.root, "manager", "CLAUDE.md"), "utf8")).toBe(guidance);
  expect(guidance).toContain("exact project path");
  expect(guidance).toContain("untrusted data");
  expect(f.snapshot.panes[0]!.cwd).toBe(join(f.root, "manager"));
});

it("refuses to close a workspace containing another pane", async () => {
  const f = fixture();
  expect(await (await f.request("/api/manager/start", { agent: "codex" })).json()).toMatchObject({ state: "running" });
  f.snapshot = { ...f.snapshot, panes: [...f.snapshot.panes, { ...f.snapshot.panes[0]!, pane_id: "other", tokens: {} }] };
  expect(await (await f.request("/api/manager/stop", { workspace_id: "w", pane_id: "p" })).json()).toMatchObject({ state: "ambiguous" });
  expect(f.closes).toBe(0);
});

it("fails closed for missing or corrupt local identity and snapshot outage", async () => {
  const f = fixture();
  expect(await (await f.request("/api/manager/start", { agent: "codex" })).json()).toMatchObject({ state: "running" });
  const path = join(f.root, "manager", "identity");
  const saved = readFileSync(path, "utf8");
  rmSync(path);
  expect(await (await f.request("/api/manager/stop", { workspace_id: "w", pane_id: "p" })).json()).toMatchObject({ state: "ambiguous" });
  writeFileSync(path, "{broken");
  expect(await (await f.request("/api/manager")).json()).toMatchObject({ state: "unavailable" });
  writeFileSync(path, saved);
  f.outage = true;
  expect(await (await f.request("/api/manager/start", { agent: "codex" })).json()).toMatchObject({ state: "unavailable" });
  expect(await (await f.request("/api/manager/stop", { workspace_id: "w", pane_id: "p" })).json()).toMatchObject({ state: "unavailable" });
  expect(f.launches).toBe(1);
  expect(f.closes).toBe(0);
});

it("lets watch devices read status but denies lifecycle mutations", async () => {
  const f = fixture(true);
  // A device cookie authenticates without a bearer token, exercising the route access guard.
  const base = `http://127.0.0.1:${servers.at(-1)!.port}`;
  const headers = { cookie: `herdr_web_device=${f.watch!.token}`, origin: base, "content-type": "application/json" };
  expect((await fetch(`${base}/api/manager`, { headers })).status).toBe(200);
  for (const path of ["start", "stop"]) {
    const response = await fetch(`${base}/api/manager/${path}`, { method: "POST", headers, body: JSON.stringify({ agent: "codex", workspace_id: "w", pane_id: "p" }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "read_only" } });
  }
  expect(f.launches).toBe(0);
});

it("prevents a second manager instance from launching while the shared directory lock is held", async () => {
  const f = fixture();
  let release!: () => void;
  f.holdStart = new Promise<void>((resolve) => { release = resolve; });
  const first = f.api.start;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.api.start = async (options: { args?: string[] }) => { entered(); return first(options); };
  const launching = f.request("/api/manager/start", { agent: "codex" });
  try {
    await started;
    const second = createManager(f.root, f.api as Parameters<typeof createManager>[1]);
    expect(await second.start("codex")).toMatchObject({ state: "ambiguous" });
    expect(f.launches).toBe(1);
  } finally { release(); }
  expect(await (await launching).json()).toMatchObject({ state: "running" });
});
