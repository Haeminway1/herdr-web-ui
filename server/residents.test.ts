import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentInfo, PaneInfo, WorkspaceInfo } from "../shared/herdr-api.generated.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import type { Residents, SystemResidentPin } from "../shared/residents.ts";
import { createServer } from "./index.ts";
import { ResidentStore, SystemPinProtectedError } from "./residents.ts";

/** the agent name the native manager registers under (server/residents.ts) */
const MANAGER_AGENT_NAME = "hm-0651225b2ed2";

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** an existing temp folder is the test's ownership root; the store must never create it */
const temp = (prefix = "herdr-residents-"): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

function pane(over: Partial<PaneInfo>): PaneInfo {
  return { agent_status: "idle", focused: false, pane_id: "w1:p1", revision: 0, tab_id: "t1", terminal_id: "term_1", workspace_id: "w1", ...over } as PaneInfo;
}
function agent(over: Partial<AgentInfo>): AgentInfo {
  return { agent_status: "idle", focused: false, name: MANAGER_AGENT_NAME, pane_id: "w1:p1", revision: 0, tab_id: "t1", terminal_id: "term_1", workspace_id: "w1", ...over } as AgentInfo;
}
function workspace(id: string, tokens?: Record<string, unknown>): WorkspaceInfo {
  return { active_tab_id: "t1", agent_status: "idle", focused: false, label: "", number: 1, pane_count: 1, tab_count: 1, workspace_id: id, ...(tokens ? { tokens } : {}) } as WorkspaceInfo;
}
function snapshot(parts: Partial<SessionSnapshot>): SessionSnapshot {
  return { agents: [], layouts: [], panes: [], protocol: 22, tabs: [], version: "0.0.0", workspaces: [], ...parts } as SessionSnapshot;
}
/** a snapshot fn that always answers `parts` */
const snapshots = (parts: Partial<SessionSnapshot>) => async (): Promise<SessionSnapshot> => snapshot(parts);

function store(file: string, managerFolder: string, snapshot: () => Promise<SessionSnapshot>): ResidentStore {
  return new ResidentStore(file, { managerFolder, snapshot });
}
/** the file's own record, raw */
const saved = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const pinFor = (folder: string, ws = "w1", p = "w1:p1", t = "term_1"): SystemResidentPin => ({ folder, workspace_id: ws, pane_id: p, terminal_id: t });

describe("ResidentStore", () => {
  it("pins the snapshot's named manager pane in the ownership root, and persists it on a plain read", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    const file = join(dir, "residents.json");
    writeFileSync(file, JSON.stringify({ top: ["/a/first"], residents: ["/a/one"], names: { "/a/one": "one" } }));
    const s = store(file, mgr, snapshots({ agents: [agent({})], panes: [pane({ cwd: mgr })], workspaces: [workspace("w1")] }));
    const residents = await s.read();
    expect(residents.top).toEqual([mgr, "/a/first"]);
    expect(residents.residents).toEqual(["/a/one"]);
    expect(residents.names).toEqual({ "/a/one": "one" });
    expect(residents.system_pin).toEqual(pinFor(mgr));
    // the read healed the file, not just the answer
    expect(saved(file).system_pin).toEqual(pinFor(mgr));
    expect(saved(file).top).toEqual([mgr, "/a/first"]);
  });

  it("pins through the workspace's hm_manager token with no named agent at all", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    const s = store(join(dir, "residents.json"), mgr, snapshots({
      panes: [pane({ cwd: mgr, workspace_id: "w7", pane_id: "w7:p3", terminal_id: "term_7" })],
      workspaces: [workspace("w7", { hm_manager: "true" })],
    }));
    const residents = await s.read();
    expect(residents.system_pin).toEqual(pinFor(mgr, "w7", "w7:p3", "term_7"));
    expect(residents.top).toEqual([mgr]);
  });

  it("heals a legacy file whose manager was demoted, duplicated or listed under the tab", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    const file = join(dir, "residents.json");
    const snap = { agents: [agent({})], panes: [pane({ cwd: mgr })], workspaces: [workspace("w1")] };
    for (const legacy of [
      { top: ["/a/first", mgr], residents: [] },
      { top: [], residents: [mgr, "/a/one"] },
      { top: ["/a/first"], residents: ["/a/one"] },
    ]) {
      writeFileSync(file, JSON.stringify(legacy));
      const residents = await store(file, mgr, snapshots(snap)).read();
      expect(residents.top).toEqual([mgr, ...legacy.top.filter((f) => f !== mgr)]);
      expect(residents.residents).toEqual(legacy.residents.filter((f) => f !== mgr));
      expect(residents.system_pin).toEqual(pinFor(mgr));
    }
  });

  it("keeps the validated pin through a reload while herdr cannot answer, and still protects it", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    const file = join(dir, "residents.json");
    writeFileSync(file, JSON.stringify({ top: [mgr, "/a/first"], residents: [], names: {}, system_pin: pinFor(mgr) }));
    const down = async (): Promise<SessionSnapshot> => { throw new Error("connect_failed: down"); };
    const s = store(file, mgr, down);
    const residents = await s.read();
    expect(residents.system_pin).toEqual(pinFor(mgr));
    expect(residents.top).toEqual([mgr, "/a/first"]);
    // the pin is not user-removable while the manager is only unreachable
    await expect(s.write({ top: ["/a/first"], residents: [] })).rejects.toBeInstanceOf(SystemPinProtectedError);
    expect(saved(file).top).toEqual([mgr, "/a/first"]);
  });

  it("rebinds to the verified manager when the saved binding's ids no longer match", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    const file = join(dir, "residents.json");
    writeFileSync(file, JSON.stringify({ top: [mgr], system_pin: pinFor(mgr, "w0", "w0:p0", "term_0") }));
    const s = store(file, mgr, snapshots({ agents: [agent({ pane_id: "w2:p2", terminal_id: "term_2", workspace_id: "w2" })], panes: [pane({ cwd: mgr, workspace_id: "w2", pane_id: "w2:p2", terminal_id: "term_2" })], workspaces: [workspace("w2")] }));
    const residents = await s.read();
    expect(residents.system_pin).toEqual(pinFor(mgr, "w2", "w2:p2", "term_2"));
  });

  it("keeps the saved pin when the manager is gone from a snapshot that did answer", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    const file = join(dir, "residents.json");
    writeFileSync(file, JSON.stringify({ top: [mgr], system_pin: pinFor(mgr) }));
    const s = store(file, mgr, snapshots({ panes: [pane({ cwd: "/elsewhere" })], workspaces: [workspace("w1")] }));
    expect((await s.read()).system_pin).toEqual(pinFor(mgr));
  });

  it("never pins a name, a label, a folder-alike or a spoofed field", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    const file = join(dir, "residents.json");
    const impostors: [string, Partial<SessionSnapshot>][] = [
      // the right pane's folder but no manager identity: a shell that happens to sit there
      ["same folder only", { panes: [pane({ cwd: mgr })], workspaces: [workspace("w1")] }],
      // the right name on a pane outside the ownership root
      ["name outside root", { agents: [agent({})], panes: [pane({ cwd: "/elsewhere" })], workspaces: [workspace("w1")] }],
      // the right name whose pane answers a different terminal than the agent claims
      ["terminal mismatch", { agents: [agent({ terminal_id: "term_9" })], panes: [pane({ cwd: mgr })], workspaces: [workspace("w1")] }],
      // the right name on a pane in another workspace than the agent's
      ["workspace mismatch", { agents: [agent({ workspace_id: "w9" })], panes: [pane({ cwd: mgr })], workspaces: [workspace("w1")] }],
      // a name look-alike is not the registration
      ["name prefix", { agents: [agent({ name: "hm-0651225b2ed2-extra" })], panes: [pane({ cwd: mgr })], workspaces: [workspace("w1")] }],
      // a label is display text, never identity
      ["label only", { panes: [pane({ cwd: mgr, label: MANAGER_AGENT_NAME })], workspaces: [workspace("w1")] }],
      // the token is the string "true", nothing else counts
      ["token wrong type", { panes: [pane({ cwd: mgr })], workspaces: [workspace("w1", { hm_manager: true })] }],
      ["token wrong value", { panes: [pane({ cwd: mgr })], workspaces: [workspace("w1", { hm_manager: "yes" })] }],
      // two workspaces claiming the manager is ambiguity, and ambiguity never picks
      ["two tokens", { panes: [pane({ cwd: mgr, pane_id: "w1:p1" }), pane({ cwd: mgr, workspace_id: "w2", pane_id: "w2:p1" })], workspaces: [workspace("w1", { hm_manager: "true" }), workspace("w2", { hm_manager: "true" })] }],
      // two panes in the one marked workspace both at the root: still ambiguous
      ["two panes one token", { panes: [pane({ cwd: mgr }), pane({ cwd: mgr, pane_id: "w1:p2", terminal_id: "term_2" })], workspaces: [workspace("w1", { hm_manager: "true" })] }],
    ];
    for (const [name, parts] of impostors) {
      const residents = await store(file, mgr, snapshots(parts)).read();
      expect(residents.system_pin, name).toBeNull();
      expect(residents.top, name).toEqual([]);
    }
  });

  it("does not trust a saved pin outside the ownership root, or half of one", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    const file = join(dir, "residents.json");
    const down = async (): Promise<SessionSnapshot> => { throw new Error("down"); };
    // a foreign folder's pin is metadata, not protection
    writeFileSync(file, JSON.stringify({ top: ["/a/fake"], system_pin: pinFor("/a/fake") }));
    const residents = await store(file, mgr, down).read();
    expect(residents.system_pin).toBeNull();
    expect(residents.top).toEqual(["/a/fake"]);
    expect(saved(file).system_pin).toBeNull();
    // half a pin in the root is not one either
    writeFileSync(file, JSON.stringify({ system_pin: { folder: mgr, workspace_id: "w1" } }));
    expect((await store(file, mgr, down).read()).system_pin).toBeNull();
  });

  it("lets an unbound deployment write what it sent, and the body's own pin counts for nothing", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    const file = join(dir, "residents.json");
    // a snapshot that answers without any manager: nothing to pin
    const s = store(file, mgr, snapshots({ panes: [pane({ cwd: "/a/one", workspace_id: "w9", pane_id: "w9:p1" })], workspaces: [workspace("w9")] }));
    const written = await s.write({ top: ["/a/two"], residents: ["/a/three"], system_pin: pinFor(mgr, "w9", "w9:p1", "term_9") });
    expect(written.top).toEqual(["/a/two"]);
    expect(written.system_pin).toBeNull();
    expect(saved(file).system_pin).toBeNull();
    // and the write minted no protection: the folder is an ordinary pin, free to leave again
    expect((await s.write({ top: [], residents: [] })).top).toEqual([]);
  });

  it("takes a write that keeps the pinned manager first and persists the server binding, not the body's", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    const file = join(dir, "residents.json");
    const snap = { agents: [agent({})], panes: [pane({ cwd: mgr })], workspaces: [workspace("w1")] };
    const s = store(file, mgr, snapshots(snap));
    await s.read();
    // order changes and other folders are the user's; a forged body pin is replaced by the server's
    const written = await s.write({
      top: [mgr, "/a/new-first"],
      residents: ["/a/one"],
      names: { "/a/one": "One" },
      system_pin: pinFor(mgr, "wX", "wX:pX", "term_X"),
    });
    expect(written.top).toEqual([mgr, "/a/new-first"]);
    expect(written.residents).toEqual(["/a/one"]);
    expect(written.names).toEqual({ "/a/one": "One" });
    expect(written.system_pin).toEqual(pinFor(mgr));
    expect(saved(file).system_pin).toEqual(pinFor(mgr));
  });

  it("refuses a write that drops the manager, demotes it, or files it under the tab — and saves nothing", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    const file = join(dir, "residents.json");
    const snap = { agents: [agent({})], panes: [pane({ cwd: mgr })], workspaces: [workspace("w1")] };
    const s = store(file, mgr, snapshots(snap));
    await s.read();
    const before = readFileSync(file, "utf8");
    for (const demoting of [
      { top: [], residents: [] },
      { top: ["/a/first", mgr], residents: [] },
      { top: ["/a/first"], residents: [mgr] },
      { residents: ["/a/one"] },
      // a body pin set null does not lift the protection
      { top: [], residents: [], system_pin: null },
    ]) {
      await expect(s.write(demoting)).rejects.toBeInstanceOf(SystemPinProtectedError);
    }
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("/api/residents", () => {
  function serve(stateDir: string, managerFolder: string): string {
    const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, protectedManagerFolder: managerFolder, machines: false, registerBridge: false, tailscaleOwner: null });
    stops.push(() => server.stop());
    return `http://127.0.0.1:${server.port}`;
  }
  const put = (base: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/residents`, { method: "PUT", headers: { "content-type": "application/json", "x-herdr-machine": "1", ...headers }, body });

  it("answers GET with the saved pin and no-store, and keeps it while herdr is unreachable", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    writeFileSync(join(dir, "residents.json"), JSON.stringify({ top: [mgr, "/a/first"], residents: ["/a/one"], names: {}, system_pin: pinFor(mgr) }));
    const base = serve(dir, mgr);
    const response = await fetch(`${base}/api/residents`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as Residents;
    expect(body.top).toEqual([mgr, "/a/first"]);
    expect(body.system_pin).toEqual(pinFor(mgr));
  });

  it("refuses PUTs that omit, demote or reorder the pinned manager with 409 system_pin_protected", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    const file = join(dir, "residents.json");
    writeFileSync(file, JSON.stringify({ top: [mgr, "/a/first"], residents: ["/a/one"], names: { "/a/one": "One" }, system_pin: pinFor(mgr) }));
    const base = serve(dir, mgr);
    for (const demoting of [
      { top: ["/a/first"], residents: ["/a/one"] },
      { top: ["/a/first", mgr], residents: ["/a/one"] },
      { top: [], residents: [mgr, "/a/one"] },
      // system_pin: null in the body does not lift the protection
      { top: [], residents: ["/a/one"], system_pin: null },
      // a forged body pin does not either
      { top: ["/a/first"], residents: ["/a/one"], system_pin: pinFor("/a/forged") },
    ]) {
      const response = await put(base, JSON.stringify(demoting));
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("system_pin_protected");
    }
    // the saved record — the user's folders and names included — is untouched by a refusal
    expect(saved(file)).toEqual({ top: [mgr, "/a/first"], residents: ["/a/one"], names: { "/a/one": "One" }, system_pin: pinFor(mgr) });
  });

  it("takes a PUT that keeps the manager first, keeps its order and edits, and ignores a forged body pin", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    writeFileSync(join(dir, "residents.json"), JSON.stringify({ top: [mgr], residents: [], names: {}, system_pin: pinFor(mgr) }));
    const base = serve(dir, mgr);
    const response = await put(base, JSON.stringify({
      top: [mgr, "/a/new"],
      residents: ["/a/one"],
      names: { "/a/one": "One" },
      launch: { kind: "codex", model: "gpt-5.5", effort: "high" },
      system_pin: pinFor("/a/forged", "wX", "wX:pX", "term_X"),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as Residents;
    expect(body.top).toEqual([mgr, "/a/new"]);
    expect(body.residents).toEqual(["/a/one"]);
    expect(body.names).toEqual({ "/a/one": "One" });
    expect(body.launch.kind).toBe("codex");
    expect(body.system_pin).toEqual(pinFor(mgr));
    // system_pin: null in the body is not a demotion while the folder stays first
    const nulled = await put(base, JSON.stringify({ top: [mgr, "/a/new"], residents: ["/a/one"], system_pin: null }));
    expect(nulled.status).toBe(200);
    expect(((await nulled.json()) as Residents).system_pin).toEqual(pinFor(mgr));
  });

  it("writes what an unbound deployment sends, without letting the body mint a pin", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    const base = serve(dir, mgr);
    const response = await put(base, JSON.stringify({ top: ["/a/one"], residents: ["/a/two"], system_pin: pinFor(mgr) }));
    expect(response.status).toBe(200);
    const body = await response.json() as Residents;
    expect(body.top).toEqual(["/a/one"]);
    expect(body.system_pin).toBeNull();
  });

  it("refuses PUTs without the machine header, from another origin, or with a body that is not JSON", async () => {
    const dir = temp();
    const mgr = realpathSync(temp("herdr-manager-"));
    writeFileSync(join(dir, "residents.json"), JSON.stringify({ top: [mgr], system_pin: pinFor(mgr) }));
    const base = serve(dir, mgr);
    const fine = { top: [mgr], residents: [] };
    // no x-herdr-machine: the app itself sends it, a cross-site form cannot add it
    expect((await fetch(`${base}/api/residents`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(fine) })).status).toBe(403);
    // a browser-origin PUT from another site is refused before the route
    const cross = await put(base, JSON.stringify(fine), { origin: "https://other.example" });
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as { error: { code: string } }).error.code).toBe("invalid_origin");
    // header right, body wrong
    const bad = await put(base, "not json{");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_json");
    // the route is GET and PUT only
    const post = await fetch(`${base}/api/residents`, { method: "POST", headers: { "x-herdr-machine": "1" }, body: "{}" });
    expect(post.status).toBe(400);
    expect(((await post.json()) as { error: { code: string } }).error.code).toBe("method_not_allowed");
  });
});
