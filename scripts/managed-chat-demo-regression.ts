import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// The demo transport is fictional; wrap only its conversation answer, never a real pane.
const app = mkdtempSync(join(tmpdir(), "herdr-managed-chat-demo-"));
const shots = join(import.meta.dir, "..", "_artifacts", "f11-shots");
const reason = "session_identity_conflict";

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const transport = `<script src="./demo-transport.js"></script><script>(() => {
    const fixtureFetch = window.fetch;
    const managed = { id: "0123456789abcdef0123456789abcdef", harness: "gjc", generation: 1, session_id: "00000000-0000-4000-8000-000000000001" };
    const ready = { ...managed, state: "ready", reason: null };
    const readOnly = { ...managed, state: "blocked", reason: "blocked_runtime_changed", readable: true };
    window.refusedTranscriptReads = 0;
    let conversationReads = 0;
    window.fetch = async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input.url, location.href).pathname;
      const state = new URL(location.href).searchParams.get("managed");
      if (path === "/api/pane/read" && ["identity_pending", "blocked"].includes(state)) window.refusedTranscriptReads++;
      const response = await fixtureFetch(input, init);
      if (path !== "/api/pane/conversation" || !response.ok) return response;
      const conversation = await response.json();
      if (state === "identity_pending" || state === "blocked" || state === "ready" || state === "read-only") {
        if (state === "identity_pending" || state === "blocked") {
          conversation.turns = [];
          conversation.source = "scrollback";
        }
        conversation.managed_session = state === "ready" ? ready
          : state === "read-only" ? readOnly
            : { id: null, harness: "gjc", generation: null, state, reason: state === "blocked" ? "${reason}" : null, session_id: null };
      }
      if (state === "transient" && conversationReads++ === 0) conversation.managed_session = ready;
      else if (state === "transient") {
        conversation.turns = [];
        conversation.source = "scrollback";
        conversation.managed_session = readOnly;
      }
      return new Response(JSON.stringify(conversation), { status: response.status, headers: { "content-type": "application/json" } });
    };
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, `${transport}\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      mkdirSync(shots, { recursive: true });
      for (const [name, viewport, phone] of [
        ["desktop", { width: 1280, height: 800 }, false],
        ["phone", { width: 390, height: 844 }, true],
      ] as const) {
        const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, locale: "en-US" });
        try {
          await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const base = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.infra)}&view=chat`;
          await page.goto(`${base}&managed=identity_pending`);
          const pending = page.locator('.pane-frame.is-current .chat-frame [data-managed-state="identity_pending"]');
          await pending.waitFor();
          assert.equal(await pending.isVisible(), true);
          assert.match(await pending.innerText(), /Waiting for managed session identity/);
          assert.equal(await page.locator(".pane-frame.is-current .chat-turn").count(), 0);
          assert.equal(await page.locator(".pane-frame.is-current .chat-terminal-fallback").count(), 0);
          assert.equal(await page.evaluate(() => (window as typeof window & { refusedTranscriptReads: number }).refusedTranscriptReads), 0);
          await page.screenshot({ path: join(shots, `${name}-identity-pending.png`) });
          await page.goto(`${base}&managed=blocked`);
          const blocked = page.locator('.pane-frame.is-current .chat-frame [data-managed-state="blocked"]');
          await blocked.waitFor();
          assert.equal(await blocked.isVisible(), true);
          assert.match(await blocked.innerText(), new RegExp(reason));
          assert.equal(await page.locator(".pane-frame.is-current .chat-turn, .pane-frame.is-current .chat-terminal-fallback").count(), 0);
          assert.equal(await page.evaluate(() => (window as typeof window & { refusedTranscriptReads: number }).refusedTranscriptReads), 0);
          await page.goto(`${base}&managed=read-only`);
          const readOnly = page.locator('.pane-frame.is-current .chat-frame [data-managed-readable="true"]');
          await readOnly.waitFor();
          assert.match(await readOnly.innerText(), /Conversation available/);
          assert.match(await readOnly.innerText(), /restarting the managed session is restricted/);
          assert.ok(await page.locator(".pane-frame.is-current .chat-turn").count() > 0);
          assert.equal(await page.locator(".pane-frame.is-current .chat-terminal-fallback").count(), 0);
          await page.screenshot({ path: join(shots, `${name}-read-only.png`) });
          await page.goto(`${base}&managed=transient`);
          await page.locator(".pane-frame.is-current .chat-turn").first().waitFor();
          const turnsBeforeTransient = await page.locator(".pane-frame.is-current .chat-turn").count();
          const transient = page.locator('.pane-frame.is-current .chat-frame [data-managed-readable="true"]');
          await transient.waitFor({ timeout: 15000 });
          assert.equal(await page.locator(".pane-frame.is-current .chat-turn").count(), turnsBeforeTransient);
          assert.equal(await page.locator(".pane-frame.is-current .chat-terminal-fallback").count(), 0);
          await page.screenshot({ path: join(shots, `${name}-read-only-transient.png`) });
          await page.goto(`${base}&managed=ready`);
          await page.locator(".pane-frame.is-current .chat-turn").first().waitFor();
          assert.equal(await page.locator(".pane-frame.is-current .chat-frame [data-managed-state]").count(), 0);
          await page.goto(base);
          await page.locator(".pane-frame.is-current .chat-turn").first().waitFor();
          assert.equal(await page.locator(".pane-frame.is-current .chat-frame [data-managed-state]").count(), 0);
          assert.deepEqual(errors, []);
          console.log(`PASS ${name}: pending, blocked, read-only, transient, ready and unmanaged chat`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
