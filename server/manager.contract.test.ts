import { afterEach, expect, it } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentManifests, sessionSnapshot } from "./herdr/client.ts";
import { createManager } from "./manager.ts";

type Frame = { id: string; method: string; params: Record<string, unknown> };
const roots: string[] = [];
const servers: Server[] = [];
const previousSocket = process.env.HERDR_SOCKET;

afterEach(async () => {
  if (previousSocket === undefined) delete process.env.HERDR_SOCKET;
  else process.env.HERDR_SOCKET = previousSocket;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("uses native RPC frames, snapshot metadata, and exact identity before closing an isolated workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-manager-contract-"));
  roots.push(root);
  const socketPath = join(root, "native.sock");
  process.env.HERDR_SOCKET = socketPath;
  const frames: Frame[] = [];
  const native = {
    workspace: undefined as { workspace_id: string; label: string } | undefined,
    pane: undefined as { pane_id: string; workspace_id: string; cwd: string; agent: string | null; tokens?: Record<string, unknown> } | undefined,
    agent: undefined as { pane_id: string; name: string; agent: string } | undefined,
  };
  let closes = 0;
  const server = createServer((connection: Socket) => {
    let input = "";
    connection.on("data", (chunk) => {
      input += chunk.toString();
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(input.slice(0, newline)) as Frame;
      frames.push(frame);
      const { params } = frame;
      let result: unknown;
      switch (frame.method) {
        case "session.snapshot": result = { snapshot: { workspaces: native.workspace ? [native.workspace] : [], panes: native.pane ? [native.pane] : [], agents: native.agent ? [native.agent] : [] } }; break;
        case "server.agent_manifests": result = { manifests: [{ agent: "codex" }] }; break;
        case "workspace.create":
          expect(params).toEqual({ cwd: join(root, "manager"), label: "Herdr Manager", focus: false });
          native.workspace = { workspace_id: "isolated-workspace", label: String(params.label) };
          native.pane = { pane_id: "isolated-pane", workspace_id: native.workspace.workspace_id, cwd: String(params.cwd), agent: null };
          result = { workspace: native.workspace, root_pane: native.pane }; break;
        case "pane.report_metadata":
          expect(params).toMatchObject({ pane_id: "isolated-pane", source: "herdr-web-manager" });
          native.pane = { ...native.pane!, tokens: params.tokens as Record<string, unknown> };
          result = {}; break;
        case "agent.start":
          expect(params).toMatchObject({ pane_id: "isolated-pane", name: "herdr-resident-manager", kind: "codex", timeout_ms: 60_000 });
          native.pane = { ...native.pane!, agent: "codex" };
          native.agent = { pane_id: native.pane.pane_id, name: String(params.name), agent: "codex" };
          result = {}; break;
        case "workspace.close":
          expect(params).toEqual({ workspace_id: "isolated-workspace" });
          closes++;
          native.workspace = undefined; native.pane = undefined; native.agent = undefined;
          result = {}; break;
        default: throw new Error(`Unexpected native method ${frame.method}`);
      }
      connection.end(JSON.stringify({ id: frame.id, result }) + "\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const manager = createManager(root);
  expect(await manager.status()).toMatchObject({ state: "absent" });
  expect(await manager.start("codex", "gpt-5", "high")).toMatchObject({ state: "running", workspace_id: "isolated-workspace", pane_id: "isolated-pane" });
  expect(frames.find((frame) => frame.method === "agent.start")?.params).toMatchObject({ args: ["--model", "gpt-5", "-c", 'model_reasoning_effort="high"'] });
  expect(native.pane?.tokens?.manager_identity).toBe(JSON.parse(readFileSync(join(root, "manager", "identity"), "utf8")).token);
  expect(await manager.stop("isolated-workspace", "wrong-pane")).toMatchObject({ state: "ambiguous" });
  expect(closes).toBe(0);
  native.pane = { ...native.pane!, tokens: { manager_identity: "forged" } };
  expect(await manager.stop("isolated-workspace", "isolated-pane")).toMatchObject({ state: "ambiguous" });
  expect(closes).toBe(0);
  native.pane = { ...native.pane!, tokens: { manager_identity: JSON.parse(readFileSync(join(root, "manager", "identity"), "utf8")).token } };
  expect(await manager.stop("isolated-workspace", "isolated-pane")).toMatchObject({ state: "stopped" });
  expect(closes).toBe(1);
  expect(await manager.status()).toMatchObject({ state: "absent" });
});

const nativeTest = Bun.which("herdr") && Bun.which("cc") ? it : it.skip;
nativeTest("starts and stops a manager on an isolated real Herdr server with a fake agent executable", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-manager-native-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(root, "config.toml"), "onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n");
  const fake = join(bin, "codex");
  const source = join(root, "fake-agent.c");
  writeFileSync(source, "#include <unistd.h>\nint main(void) { for (;;) pause(); }\n");
  expect(Bun.spawnSync([Bun.which("cc")!, source, "-o", fake]).exitCode).toBe(0);
  const name = `manager-fixture-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const socket = join(root, "xdg", "herdr", "sessions", name, "herdr.sock");
  const previousPath = process.env.PATH;
  const server = Bun.spawn([Bun.which("herdr")!, "--session", name, "server"], {
    cwd: root,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(root, "xdg"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), HERDR_CONFIG_PATH: join(root, "config.toml"), PATH: `${bin}:/usr/bin:/bin` },
    stdout: "ignore", stderr: "ignore",
  });
  try {
    for (let i = 0; !existsSync(socket) && i < 100 && server.exitCode === null; i++) await Bun.sleep(50);
    expect(existsSync(socket)).toBe(true);
    process.env.HERDR_SOCKET = socket;
    process.env.PATH = `${bin}:${previousPath ?? "/usr/bin:/bin"}`;
    const manifests = await agentManifests();
    expect(manifests.manifests.some((manifest) => manifest.agent === "codex")).toBe(true);
    const manager = createManager(root);
    const started = await manager.start("codex");
    expect(started).toMatchObject({ state: "running" });
    const running = await manager.status();
    expect(running.state).toBe("running");
    if (running.state !== "running" || !running.workspace_id || !running.pane_id) throw new Error("Native manager identity is missing");
    const snapshot = await sessionSnapshot();
    expect(snapshot.panes.find((pane) => pane.pane_id === running.pane_id)?.tokens?.manager_identity).toBe(JSON.parse(readFileSync(join(root, "manager", "identity"), "utf8")).token);
    expect(snapshot.agents.some((agent) => agent.pane_id === running.pane_id && agent.name === "herdr-resident-manager")).toBe(true);
    expect(await manager.stop(running.workspace_id, running.pane_id)).toMatchObject({ state: "stopped" });
    expect(await manager.status()).toMatchObject({ state: "absent" });
  } finally {
    process.env.PATH = previousPath;
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET;
    else process.env.HERDR_SOCKET = previousSocket;
    server.kill();
    await server.exited;
  }
}, 20_000);
