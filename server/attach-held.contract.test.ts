import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

/**
 * Two web bridges on one herdr (a second install beside the first): herdr gives one of them
 * a terminal's attach. The other waits for it instead of ending the pane, and attaches as
 * soon as the first lets go.
 */
const rootA = mkdtempSync(join(tmpdir(), "herdr-held-a-"));
const rootB = mkdtempSync(join(tmpdir(), "herdr-held-b-"));
const first = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: rootA });
const second = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: rootB, attachHeldRetryMs: 200 });
const workspaces: string[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const socket of sockets) socket.close();
  first.stop();
  second.stop();
  for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace });
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

async function until(check: () => boolean, label: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

function connect(port: number, paneId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const state = { frames: 0, errors: [] as string[], exits: 0, resumed: 0, submits: [] as { ok: boolean; code?: string }[] };
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerMessage;
    if (frame.type === "error") state.errors.push(frame.code);
    if (frame.type === "pty-exit" && frame.pane_id === paneId) state.exits++;
    if (frame.type === "attach-resumed" && frame.pane_id === paneId) state.resumed++;
    if (frame.type === "pty-data" && frame.pane_id === paneId) state.frames++;
    if (frame.type === "submit-result" && frame.pane_id === paneId) state.submits.push({ ok: frame.ok, code: frame.code });
  });
  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
  const open = until(() => ws.readyState === WebSocket.OPEN, "socket open");
  return { ws, state, send, open };
}

describe("a terminal another web bridge holds", () => {
  it("waits for that bridge instead of ending, then attaches when it lets go", async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: "herdr-web-ui-test-held", cwd: rootA, focus: false },
    );
    workspaces.push(created.workspace.workspace_id);
    const paneId = created.root_pane.pane_id;

    const a = connect(first.port, paneId);
    await a.open;
    a.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
    await until(() => a.state.frames > 0, "first bridge attached");

    const b = connect(second.port, paneId);
    await b.open;
    b.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
    await until(() => b.state.errors.includes("attach_held"), "second bridge told the pane is held");
    // several retries go by: still waiting, never ended, and told only once
    await Bun.sleep(900);
    expect(b.state.exits).toBe(0);
    expect(b.state.errors.filter((code) => code === "attach_held")).toHaveLength(1);
    expect(b.state.errors).not.toContain("attach_conflict");
    // the first bridge's attach was left alone
    expect(a.state.exits).toBe(0);
    // nothing is typed through the waiting bridge into a pane the other one has
    b.send({ type: "submit", id: 1, pane_id: paneId, text: "echo held", payload: "echo held" });
    await until(() => b.state.submits.length === 1, "submit answered while held");
    expect(b.state.submits[0]).toEqual({ ok: false, code: "attach_held" });

    // the first bridge lets go: the second attaches on its next try
    a.send({ type: "detach", pane_id: paneId });
    await until(() => b.state.resumed === 1, "second bridge attached after the first let go");
    await until(() => b.state.frames > 0, "second bridge paints the terminal");
    expect(b.state.exits).toBe(0);
  }, 30_000);
});
