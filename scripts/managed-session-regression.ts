/** Actual HTTP + Chromium against an owned fake SDK/socket and synthetic transcripts only. */
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { HerdrPane, InteractivePrompt, SessionSnapshot } from "../shared/protocol.ts";
import { createServer } from "../server/index.ts";
import { EVENTS_SUBSCRIBE_METHOD } from "../server/herdr/client.ts";
import { labelManagedPanes } from "../server/managed-sessions.ts";
import { UsageService } from "../server/usage.ts";

assert(!process.argv.includes("--live"), "This regression supports synthetic fixtures only");
const root = mkdtempSync(join(tmpdir(), "herdr-managed-browser-"));
const namespace = join(root, "managed-sessions");
const nonce = "fedcba9876543210fedcba9876543210";
const sessionId = "00000000-0000-4000-8000-000000000001";
const question = "어떤 방식을 선택할까요?";
const choices = [
  "현재 동작을 유지하면서 긴 한국어 선택지를 여러 줄에 걸쳐 정확하게 표시합니다",
  "이름이 매우 길어서 비선택 상태에서는 말줄임표로 잘리는 두 번째 선택지",
  "취소",
];
const labels = [...choices, "Other (type your own)"];
const askRecord = (id: string) => JSON.stringify({
  type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "ask", id, arguments: { questions: [{ question, options: choices.map(label => ({ label })) }] } }] },
}) + "\n";
const resultRecord = (id: string) => JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: id, isError: false, content: [] } }) + "\n";

// Same faithful synthetic GJC 0.18.12 outline/wrapFocused layout as prompt.test.ts.
// Only the focused choice wraps; siblings truncate to the available label columns.
function wrap(text: string, width: number): string[] {
  const rows: string[] = [];
  let part = "";
  for (const char of text) {
    if (Bun.stringWidth(part + char) > width) {
      const space = part.lastIndexOf(" ");
      rows.push((space > 0 ? part.slice(0, space) : part).trim());
      part = space > 0 ? part.slice(space + 1) : "";
    }
    part += char;
  }
  rows.push(part.trim());
  return rows.filter(Boolean);
}

function nativeMenu(at: number, width = 24): string {
  const limit = width - 4;
  const truncate = (label: string) => {
    if (Bun.stringWidth(label) <= limit) return label;
    let prefix = "";
    for (const char of label) {
      if (Bun.stringWidth(prefix + char + "…") > limit) break;
      prefix += char;
    }
    return prefix + "…";
  };
  const rows: string[] = [];
  for (const [index, label] of labels.entries()) {
    if (index !== at) { rows.push(`  ${truncate(label)}`); continue; }
    wrap(label, limit).forEach((text, row) => rows.push(`${row === 0 ? "❯ " : "  "}${text.trimStart()}`));
  }
  const border = "─".repeat(width);
  const footer = "↑/↓ select  enter  esc  PgUp/PgDn/Ctrl+u/d: question · Wheel: transcript";
  return [border, "", ...wrap(question, width - 2).map(line => ` ${line}`), "", border,
    ...rows.map(row => `│${row}${" ".repeat(Math.max(0, width - 2 - Bun.stringWidth(row)))}│`),
    border, "", ...wrap(footer, width - 2).map(line => ` ${line}`), "", border, ""].join("\n");
}

let callId = "synthetic-gjc-ask-1";
let cursor = 0;
let menuOpen = true;
let screen = nativeMenu(cursor);
let screenRevision = 1;
let lastReadRevision = 0;
let allowAnswerKeys = false;
const sentKeys: string[] = [];
const redraw = () => { screen = nativeMenu(cursor); screenRevision += 1; };
const directory = join(namespace, `${nonce}.sessions`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = join(directory, "exact.jsonl");
writeFileSync(file, [
  { type: "session", id: sessionId, cwd: root },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "Synthetic identity regression" }] } },
  { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Exact managed GJC fixture connected." }] } },
].map(row => JSON.stringify(row)).join("\n") + "\n" + askRecord(callId), { mode: 0o600 });
const oldPath = process.env.PATH;
const engine = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { cwd: root, env: { HOME: root }, stdout: "ignore", stderr: "ignore" });
const engineStat = readFileSync(`/proc/${engine.pid}/stat`, "utf8");
const child = { pid: engine.pid, starttime: engineStat.slice(engineStat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]!, boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), cwd: root };
const pane: HerdrPane = { pane_id: "wManagedFixture:p1", tab_id: "wManagedFixture:t1", workspace_id: "wManagedFixture", terminal_id: "term_managed_fixture", cwd: root, agent: "codex", agent_status: "unknown", focused: true, revision: 1, label: "Managed GJC fixture", tokens: { hm_managed_session: nonce, hm_managed_generation: "1", hm_execution: "gjc fixture" } };
const record = { schema: 1, nonce, harness: "gjc", launcher_harness: "gjc", generation: 1, cwd: root, pane_id: pane.pane_id, workspace_id: pane.workspace_id, terminal_id: pane.terminal_id, desired_state: "running", state: "ready", error: "", session_id: sessionId, session_file: file, session_dir: directory, child };
const save = () => writeFileSync(join(namespace, `${nonce}.json`), JSON.stringify(record), { mode: 0o600 });
save();
// Same owned SDK command convention as gjc-status-browser-regression.ts. No saved-store index.
const sdkBin = join(root, "bin"); mkdirSync(sdkBin);
const sdkCommand = join(sdkBin, "gjc");
writeFileSync(sdkCommand, `#!${process.execPath}
console.log(JSON.stringify({ type: "broker_response", ok: true, result: {
  indexSeq: 1, continuationCursor: null, savedSession: null, sessions: [{
    sessionId: ${JSON.stringify(sessionId)}, pid: ${child.pid}, hostIncarnation: ${JSON.stringify(`linux:${child.starttime}`)},
    endpointGeneration: 1, identityProvenance: "composite", live: true, terminal: false, terminalUncertain: false, ambiguous: false,
    locator: { cwd: ${JSON.stringify(root)}, worktreeRoot: null, stateRoot: ${JSON.stringify(root)} }
  }]
} }));
`);
chmodSync(sdkCommand, 0o700);
process.env.PATH = `${sdkBin}:${oldPath ?? ""}`;
function snapshotFor(p: HerdrPane): SessionSnapshot {
  return { protocol: 22, version: "fixture", panes: [p], agents: [{ ...p, name: "provider-child" }], workspaces: [{ workspace_id: p.workspace_id, active_tab_id: p.tab_id, label: "Managed session verification", number: 1, pane_count: 1, tab_count: 1, agent_status: "unknown", focused: true }], tabs: [{ tab_id: p.tab_id, workspace_id: p.workspace_id, number: 1, label: "Managed session verification", pane_count: 1, focused: true, agent_status: "unknown" }], layouts: [], focused_pane_id: p.pane_id };
}
const rawSnapshot = snapshotFor(pane);
const oldSocket = process.env.HERDR_SOCKET;
const oldNamespace = process.env.HERDR_MANAGED_NAMESPACE;
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
      let result: unknown = request.method === "session.snapshot" ? { snapshot: rawSnapshot }
        : request.method === "ping" ? { version: "fixture", protocol: 22 }
          : request.method === EVENTS_SUBSCRIBE_METHOD ? { type: "subscription_started" }
            : request.method === "server.agent_manifests" ? { manifests: [] } : null;
      if (request.method === "pane.read") {
        assert.equal(request.params.pane_id, pane.pane_id);
        lastReadRevision = screenRevision;
        result = { read: { text: screen } };
      }
      if (request.method === "pane.send_keys") {
        assert(allowAnswerKeys, "Only the isolated PromptCard click may send keys");
        assert.equal(request.params.pane_id, pane.pane_id);
        assert(menuOpen, "Keys cannot reach a completed fixture menu");
        assert(Array.isArray(request.params.keys) && request.params.keys.length === 1);
        for (const key of request.params.keys) {
          assert(["up", "down", "enter"].includes(key), "Only logical menu movement and Enter are allowed");
          sentKeys.push(key);
          if (key === "up") cursor = Math.max(0, cursor - 1);
          if (key === "down") cursor = Math.min(labels.length - 1, cursor + 1);
          if (key === "enter") {
            assert.equal(cursor, 0, "The complete first Korean label must be selected");
            appendFileSync(file, resultRecord(callId) + JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Synthetic choice completed." }] } }) + "\n");
            menuOpen = false;
            screen = "Synthetic choice completed.\n❯ \n";
            screenRevision += 1;
          } else redraw();
        }
        result = {};
      }
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(() => {
    if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  const forbidden: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // No terminal attach/input reaches the backend. Only the explicit fake-menu HTTP answer may write.
  await page.routeWebSocket(/\/ws(?:\?|$)/, async socket => {
    socket.send(JSON.stringify({ type: "snapshot", snapshot: await labelManagedPanes(rawSnapshot), features: [] }));
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === "role") socket.send(JSON.stringify({ type: "role-ack", mode: message.mode }));
      if (message.type === "ping") socket.send(JSON.stringify({ type: "pong", id: message.id }));
      if (["input", "submit", "keys", "stop"].includes(message.type)) forbidden.push(message.type);
    });
  });
  let browserAnswers = 0;
  let blockedSeen = 0;
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { forbidden.push("external request"); await route.abort(); return; }
    if (request.method() === "POST" && url.pathname === "/api/pane/seen") { blockedSeen += 1; await route.abort(); return; }
    if (request.method() !== "GET") {
      if (request.method() !== "POST" || url.pathname !== "/api/pane/prompt/answer" || !allowAnswerKeys) {
        forbidden.push(`${request.method()} ${url.pathname}`); await route.abort(); return;
      }
      assert.equal(request.postDataJSON().pane_id, pane.pane_id);
      browserAnswers += 1;
    }
    if (/\/pane\/(read|transcript)$/.test(url.pathname)) forbidden.push("scrollback fallback");
    await route.continue();
  });
  const promptUrl = `${origin}/api/pane/prompt?pane_id=${encodeURIComponent(pane.pane_id)}`;
  async function currentPrompt(): Promise<InteractivePrompt | null> {
    const response = await fetch(promptUrl);
    assert.equal(response.status, 200);
    return (await response.json() as { prompt: InteractivePrompt | null }).prompt;
  }
  async function refuseStale(id: string): Promise<void> {
    const before = [...sentKeys];
    const response = await fetch(`${origin}/api/pane/prompt/answer`, {
      method: "POST", headers: { "content-type": "application/json", origin, "x-herdr-machine": "1" },
      body: JSON.stringify({ pane_id: pane.pane_id, prompt_id: id, option_index: 0 }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "prompt_changed");
    assert.deepEqual(sentKeys, before, "A stale/non-ready card must never send a key");
  }
  const card = page.locator(".prompt-card");
  async function completeLabels(): Promise<void> {
    await card.locator(".prompt-card-option-label").last().waitFor();
    assert.equal(await card.count(), 1);
    assert.deepEqual(await card.locator(".prompt-card-option-label").allTextContents(), labels, "No physical wrap fragment may become an extra choice");
    assert.equal(await card.locator("button.prompt-card-option").count(), labels.length);
    for (const label of labels) {
      const rendered = card.getByText(label, { exact: true });
      assert.equal(await rendered.count(), 1);
      assert(await rendered.isVisible());
    }
  }
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
  const initial = await currentPrompt();
  assert(initial);
  assert.equal(initial.kind, "question");
  assert.equal(initial.question, question);
  assert.deepEqual(initial.options.map(option => option.label), labels);
  assert.equal(initial.fallback, undefined);
  await completeLabels();
  if (evidence) await page.screenshot({ path: join(evidence, "managed-gjc-ready.png") });
  console.log("PASS synthetic managed GJC: owned SDK identity, exact HTTP transcript and complete logical Korean PromptCard labels");

  record.state = "identity_pending"; save();
  await page.locator(".chat-transcript [data-managed-state='identity_pending']").waitFor();
  await page.locator(".composer-status [data-managed-state='identity_pending']").waitFor();
  await page.getByText("Exact managed GJC fixture connected.", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.getByText("No conversation yet — say something below", { exact: true }).count(), 0);
  assert.equal(await currentPrompt(), null);
  await card.waitFor({ state: "hidden" });
  await refuseStale(initial.id);
  if (evidence) await page.screenshot({ path: join(evidence, "managed-gjc-pending.png") });
  record.state = "blocked"; record.error = "blocked_runtime_changed"; save();
  await page.locator(".chat-transcript [data-managed-state='blocked']").filter({ hasText: "blocked_runtime_changed" }).waitFor();
  await page.locator(".composer-status [data-managed-state='blocked']").waitFor();
  assert.equal(await currentPrompt(), null);
  await card.waitFor({ state: "hidden" });
  await refuseStale(initial.id);
  if (evidence) await page.screenshot({ path: join(evidence, "managed-gjc-blocked.png") });
  record.state = "ready"; record.error = ""; save();
  await page.getByText("Exact managed GJC fixture connected.", { exact: true }).waitFor();
  await completeLabels();
  console.log("PASS ready → pending → blocked → ready: no stale conversation or scrollback guessing");

  const previousGeneration = await currentPrompt();
  assert(previousGeneration);
  record.generation = 2; pane.tokens!.hm_managed_generation = "2"; save();
  await refuseStale(previousGeneration.id);
  const previousCall = await currentPrompt();
  assert(previousCall);
  assert.notEqual(previousCall.id, previousGeneration.id);
  appendFileSync(file, resultRecord(callId));
  callId = "synthetic-gjc-ask-2";
  appendFileSync(file, askRecord(callId));
  await refuseStale(previousCall.id);
  const actionable = await currentPrompt();
  assert(actionable);
  assert.notEqual(actionable.id, previousCall.id);
  assert.deepEqual(actionable.options.map(option => option.label), labels);
  assert.deepEqual(sentKeys, []);
  await open(pane.pane_id);
  await completeLabels();

  const sameCard = await card.elementHandle();
  const sameButton = await card.locator("button.prompt-card-option").first().elementHandle();
  assert(sameCard && sameButton);
  await sameButton.focus();
  for (const at of [1, 2]) {
    const polled = page.waitForResponse(response => response.url() === promptUrl && response.request().method() === "GET" && lastReadRevision === screenRevision);
    cursor = at; redraw();
    const response = await polled;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).prompt.id, actionable.id, "A cursor-only native redraw must retain the card identity");
    assert(await sameCard.evaluate(async node => {
      // Let React consume this poll before checking that the original card remains mounted.
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      return node.isConnected && document.querySelector(".prompt-card") === node;
    }), "Cursor redraw must not remount PromptCard");
    assert(await sameButton.evaluate(node => document.activeElement === node), "Cursor redraw must retain button focus");
    await completeLabels();
  }
  if (evidence) await page.screenshot({ path: join(evidence, "managed-gjc-wrapped-prompt.png") });
  allowAnswerKeys = true;
  try {
    const answered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/pane/prompt/answer" && response.request().method() === "POST");
    await card.locator("button.prompt-card-option").first().click();
    const response = await answered;
    assert.equal(response.status(), 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(response.request().postDataJSON(), { pane_id: pane.pane_id, prompt_id: actionable.id, option_index: 0 });
  } finally { allowAnswerKeys = false; }
  assert.equal(browserAnswers, 1, "One click must make exactly one successful answer request");
  assert.deepEqual(sentKeys, ["up", "up", "enter"], "Movement follows logical choices, never physical wrap rows or digit guesses");
  assert.equal(menuOpen, false);
  assert.equal(await currentPrompt(), null);
  await card.waitFor({ state: "hidden" });
  await page.getByText("Synthetic choice completed.", { exact: true }).waitFor();
  const settled = await page.waitForResponse(response => response.url() === promptUrl && response.request().method() === "GET");
  assert.equal((await settled.json()).prompt, null);
  assert.equal(await card.count(), 0, "A settled ask must not reappear on the next poll");
  await refuseStale(actionable.id);
  console.log("PASS isolated PromptCard: stable native redraw, stale generation/call refusal, logical up/up/Enter, HTTP 200 and settled-card removal");

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

  assert.deepEqual(errors, []);
  assert.deepEqual(forbidden, []);
  console.log(`Blocked ${blockedSeen} automatic pane/seen POSTs before the backend`);
  assert(!methods.some(method => method !== "pane.send_keys" && /(?:create|close|start|send|rename|move|run|report|write)/.test(method)), "Non-menu mutation RPC attempted");
  assert(!methods.includes("pane.process_info"), "managed resolver fell through to process heuristics");
} finally {
  await browser?.close();
  server.stop(); listener.stop(true);
  engine.kill(); await engine.exited;
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  if (oldSocket === undefined) delete process.env.HERDR_SOCKET; else process.env.HERDR_SOCKET = oldSocket;
  if (oldNamespace === undefined) delete process.env.HERDR_MANAGED_NAMESPACE; else process.env.HERDR_MANAGED_NAMESPACE = oldNamespace;
  rmSync(root, { recursive: true, force: true });
}
