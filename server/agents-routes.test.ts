import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import { HerdrError } from "./herdr/client.ts";
import { createServer } from "./index.ts";
import type { ShellAgentLocator } from "./shell-agent.ts";

describe("GET /api/agents", () => {
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  let bin: string;
  const savedPath = process.env["PATH"];
  // the shell-started agents this server finds: gjc here, omo not
  const located: string[] = [];
  const shellAgents = { executable: async (kind: string) => { located.push(kind); return kind === "gjc" ? "/opt/gjc/bin/gjc" : null; }, stop: async () => undefined } as unknown as ShellAgentLocator;
  const manifests = spyOn(herdr, "agentManifests").mockImplementation(async () => ({ manifests: [{ agent: "codex" }, { agent: "pi" }, { agent: "someagent" }] }) as unknown as Awaited<ReturnType<typeof herdr.agentManifests>>);
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-agents-route-"));
    bin = mkdtempSync(join(tmpdir(), "ovis-agents-bin-"));
    // only codex is on this server's PATH
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
    chmodSync(join(bin, "codex"), 0o755);
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false, shellAgents });
  });
  afterEach(() => {
    process.env["PATH"] = savedPath;
    located.length = 0;
    manifests.mockClear();
  });
  afterAll(() => {
    server.stop();
    manifests.mockRestore();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  it("offers herdr's agents, Oh My Pi and Claude Code always, and the shell agents this server finds, by label", async () => {
    process.env["PATH"] = bin;
    const response = await fetch(url("/api/agents"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      agents: [
        { kind: "claude", label: "Claude Code", installed: false },
        { kind: "codex", label: "Codex", installed: true },
        { kind: "gjc", label: "Gajae Code", installed: true },
        { kind: "omp", label: "Oh My Pi", installed: false },
        { kind: "pi", label: "pi", installed: false },
        { kind: "someagent", label: "someagent", installed: false },
      ],
    });
    expect(located.sort()).toEqual(["gjc", "omo"]);
  });

  it("passes herdr's own error through, and refuses anything but GET", async () => {
    manifests.mockImplementationOnce(async () => { throw new HerdrError("connect_failed", "herdr is not answering"); });
    const unreachable = await fetch(url("/api/agents"));
    expect(unreachable.status).toBe(502);
    expect(((await unreachable.json()) as { error: { code: string } }).error.code).toBe("connect_failed");
    const post = await fetch(url("/api/agents"), { method: "POST", headers: { origin: url("") } });
    expect(post.status).toBe(400);
    expect(((await post.json()) as { error: { code: string } }).error.code).toBe("method_not_allowed");
  });
});
