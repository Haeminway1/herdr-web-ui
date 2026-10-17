/** Actual HTTP + Chromium, synthetic transcripts only. --live observes the pane list read-only. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { createServer } from "../server/index.ts";
import { EVENTS_SUBSCRIBE_METHOD, herdrRpc } from "../server/herdr/client.ts";
import { labelManagedPanes, managedNamespace } from "../server/managed-sessions.ts";
import { UsageService } from "../server/usage.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-managed-browser-"));
const namespace = join(root, "managed-sessions");
const nonce = "fedcba9876543210fedcba9876543210";
const sessionId = "01a147f3-ec90-756f-948e-9fcb84998ec3";
const directory = join(namespace, `${nonce}.sessions`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = join(directory, "exact.jsonl");
writeFileSync(file, [
  { type: "session", id: sessionId, cwd: root },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "Synthetic identity regression" }] } },
  { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Exact managed GJC fixture connected." }] } },
].map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
const info = statSync(file);
const pane: HerdrPane = { pane_id: "wManagedFixture:p1", tab_id: "wManagedFixture:t1", workspace_id: "wManagedFixture", terminal_id: "term_managed_fixture", cwd: root, agent: "codex", agent_status: "unknown", focused: true, revision: 1, label: "Managed GJC fixture", tokens: { hm_managed_session: nonce, hm_managed_generation: "1", hm_execution: "gjc fixture" } };
const record = { schema: 2, nonce, harness: "gjc", launcher_harness: "gjc", generation: 1, cwd: root, pane_id: pane.pane_id, workspace_id: pane.workspace_id, terminal_id: pane.terminal_id, desired_state: "running", state: "ready", error: "", session_id: sessionId, session_file: file, session_dir: directory, file_identity: { dev: info.dev, ino: info.ino } };
const save = () => writeFileSync(join(namespace, `${nonce}.json`), JSON.stringify(record), { mode: 0o600 });
save();
function snapshotFor(p: HerdrPane): SessionSnapshot {
  return { protocol: 22, version: "fixture", panes: [p], agents: [{ ...p, name: "provider-child" }], workspaces: [{ workspace_id: p.workspace_id, active_tab_id: p.tab_id, label: "Managed session verification", number: 1, pane_count: 1, tab_count: 1, agent_status: "unknown", focused: true }], tabs: [{ tab_id: p.tab_id, workspace_id: p.workspace_id, number: 1, label: "Managed session verification", pane_count: 1, focused: true, agent_status: "unknown" }], layouts: [], focused_pane_id: p.pane_id };
}
let rawSnapshot = snapshotFor(pane);
const oldSocket = process.env.HERDR_SOCKET;
const oldNamespace = process.env.HERDR_MANAGED_NAMESPACE;
const liveNamespace = managedNamespace();
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const methods: string[] = [];
const unix = join(root, "fixture.sock");
const listener = Bun.listen<{ buffer: string }>({
  unix,
  socket: {
    open(socket) { socket.data = { buffer: "" }; },
    data(socket, chunk) {
      socket.data.buffer += chunk.toString();
      const newline = socket.data.buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(socket.data.buffer.slice(0, newline));
      socket.data.buffer = socket.data.buffer.slice(newline + 1);
      methods.push(request.method);
      const result = request.method === "session.snapshot" ? { snapshot: rawSnapshot }
        : request.method === "ping" ? { version: "fixture", protocol: 22 }
          : request.method === EVENTS_SUBSCRIBE_METHOD ? { type: "subscription_started" }
            : request.method === "server.agent_manifests" ? { manifests: [] } : null;
      socket.write(JSON.stringify(result === null ? { id: request.id, error: { code: "fixture_read_only", message: "Only fixture reads are allowed" } } : { id: request.id, result }) + "\n");
      if (request.method !== EVENTS_SUBSCRIBE_METHOD) socket.end();
    },
  },
});
process.env.HERDR_SOCKET = unix;
process.env.HERDR_MANAGED_NAMESPACE = namespace;
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "web-state"), usage: new UsageService(undefined, []), tailscaleOwner: null });
const origin = `http://127.0.0.1:${server.port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  const forbidden: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // No attach, resize, input, or provider call can reach even the fixture backend.
  await page.routeWebSocket(/\/ws(?:\?|$)/, socket => {
    socket.send(JSON.stringify({ type: "snapshot", snapshot: labelManagedPanes(rawSnapshot), features: [] }));
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === "role") socket.send(JSON.stringify({ type: "role-ack", mode: message.mode }));
      if (message.type === "ping") socket.send(JSON.stringify({ type: "pong", id: message.id }));
      if (["input", "submit", "keys", "stop"].includes(message.type)) forbidden.push(message.type);
    });
  });
  await page.route("**/api/**", async route => {
    if (route.request().method() !== "GET") { forbidden.push(route.request().method()); await route.abort(); return; }
    if (route.request().url().includes("/pane/prompt?")) { await route.fulfill({ json: { prompt: null } }); return; }
    if (/\/pane\/(read|transcript)\?/.test(route.request().url())) forbidden.push("scrollback fallback");
    await route.continue();
  });
  async function open(paneId: string) {
    await page.goto(origin);
    await page.evaluate(id => localStorage.setItem(`herdr-web-ui:view:${id}`, "chat"), paneId);
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(`.pane-item.is-selected [data-pane='${paneId}'], .cl-pane-item.is-selected`).first().waitFor();
    await page.locator(".composer-status:not([data-offline])").waitFor();
  }
  await open(pane.pane_id);
  await page.getByText("Exact managed GJC fixture connected.", { exact: true }).waitFor();
  assert.equal((await (await fetch(`${origin}/api/session`)).json()).snapshot.panes[0].agent, "gjc");
  const ready = await (await fetch(`${origin}/api/pane/conversation?pane_id=${pane.pane_id}`)).json();
  assert.equal(ready.source, "gjc-transcript"); assert.equal(ready.managed_session.session_id, sessionId);
  if (evidence) await page.screenshot({ path: join(evidence, "managed-gjc-ready.png") });
  console.log("PASS schema-2 managed GJC: exact HTTP transcript and Chromium badge, despite raw Codex label");

  record.state = "identity_pending"; save();
  await page.locator(".chat-transcript [data-managed-state='identity_pending']").waitFor();
  await page.locator(".composer-status [data-managed-state='identity_pending']").waitFor();
  await page.getByText("Exact managed GJC fixture connected.", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.getByText("No conversation yet — say something below", { exact: true }).count(), 0);
  if (evidence) await page.screenshot({ path: join(evidence, "managed-gjc-pending.png") });
  record.state = "blocked"; record.error = "blocked_runtime_changed"; save();
  await page.locator(".chat-transcript [data-managed-state='blocked']").filter({ hasText: "blocked_runtime_changed" }).waitFor();
  await page.locator(".composer-status [data-managed-state='blocked']").waitFor();
  if (evidence) await page.screenshot({ path: join(evidence, "managed-gjc-blocked.png") });
  record.state = "ready"; record.error = ""; save();
  await page.getByText("Exact managed GJC fixture connected.", { exact: true }).waitFor();
  console.log("PASS ready → pending → blocked → ready: no stale conversation or scrollback guessing");

  // The everyday fork uses ClassicSidebar, not the automation browser's default.
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}");
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ ...settings, sidebarLayout: "classic" }));
  });
  record.state = "blocked"; record.error = "blocked_runtime_changed"; save();
  await open(pane.pane_id);
  await page.locator(".cl-pane-item.is-selected .cl-agent-mark-holder[title='gjc']").waitFor();
  await page.locator(".cl-pane-item.is-selected [data-managed-state='blocked']").waitFor();
  await page.locator(".chat-transcript [data-managed-state='blocked']").waitFor();
  if (evidence) await page.screenshot({ path: join(evidence, "managed-gjc-classic.png") });
  console.log("PASS default fork sidebar: GJC identity and blocked reason retained");

  if (process.argv.includes("--live")) {
    // Exactly one read-only snapshot. Never read live message bodies or screens.
    const socket = join(homedir(), ".config/herdr/sessions/phase1/herdr.sock");
    const live = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {}, socket)).snapshot;
    const project = resolve(import.meta.dir, "..").split("/.worktrees/")[0]!;
    const target = live.panes.find(p => p.cwd === project && typeof p.tokens?.hm_managed_session === "string");
    assert(target, "live pane list has no managed pane for this project");
    const safePane: HerdrPane = { ...target, label: "Managed GJC — read-only observation", terminal_title: null, terminal_title_stripped: null, title: null, tokens: { hm_managed_session: target.tokens!.hm_managed_session, hm_managed_generation: target.tokens!.hm_managed_generation } };
    rawSnapshot = snapshotFor(safePane);
    process.env.HERDR_MANAGED_NAMESPACE = liveNamespace;
    const projected = labelManagedPanes(rawSnapshot, liveNamespace).panes[0]!;
    assert.equal(projected.agent, "gjc");
    assert(projected.managed_session);
    // Do not read live messages even when a future schema-2 pane is ready.
    await page.route("**/api/pane/conversation?**", route => route.fulfill({ json: {
      source: projected.managed_session!.state === "ready" ? "gjc-transcript" : "scrollback",
      turns: [], managed_session: projected.managed_session,
    } }));
    await open(target.pane_id);
    await page.locator(`.composer-status [data-managed-state='${projected.managed_session.state}']`).waitFor();
    if (evidence) await page.screenshot({ path: join(evidence, "managed-gjc-live-readonly.png") });
    console.log(JSON.stringify({ check: "live-read-only", pane_id: target.pane_id, raw_agent: target.agent ?? null, projected_agent: projected.agent, managed_state: projected.managed_session.state, reason: projected.managed_session.reason, conversation_body_read: false, terminal_attached: false }));
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(forbidden, []);
  assert(!methods.some(method => /(?:create|close|start|send|rename|move|run|report|write)/.test(method)), "mutation RPC attempted");
  assert(!methods.includes("pane.process_info"), "managed resolver fell through to process heuristics");
} finally {
  await browser?.close();
  server.stop(); listener.stop(true);
  if (oldSocket === undefined) delete process.env.HERDR_SOCKET; else process.env.HERDR_SOCKET = oldSocket;
  if (oldNamespace === undefined) delete process.env.HERDR_MANAGED_NAMESPACE; else process.env.HERDR_MANAGED_NAMESPACE = oldNamespace;
  rmSync(root, { recursive: true, force: true });
}
