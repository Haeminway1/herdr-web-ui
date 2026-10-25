/** The production App route over the fictional demo transport. Never connects to live herdr. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { appFaces } from "./app-faces.ts";

interface Fixture {
  reads: number;
  promptReads: number;
  restored: string | null;
  managedState: "identity_pending" | "blocked" | "ready" | null;
  terminalReads: number;
  olderReads: number;
  releaseOlder: () => void;
  version: number;
  update: (kind: "stream" | "append" | "status") => void;
  submissions: Array<{ id: number; text: string }>;
  acknowledge: (ok: boolean, code?: string) => void;
}
declare global { interface Window { mobileChatQa: Fixture } }
const app = mkdtempSync(join(tmpdir(), "herdr-mobile-chat-app-"));
const evidence = process.env.UI_EVIDENCE_DIR;
const failures: string[] = [];
const results: Array<{ name: string; passed: boolean; geometry: Awaited<ReturnType<typeof geometry>>; error?: string }> = [];
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const chat = (page: Page) => page.locator(".pane-frame.is-current .chat-view");
const geometry = (page: Page) => chat(page).evaluate((node) => ({ top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight, gap: node.scrollHeight - node.clientHeight - node.scrollTop }));
async function bottom(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const node = document.querySelector(".pane-frame.is-current .chat-view");
    return node !== null && Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 1;
  });
  await settled(page);
}
async function update(page: Page, kind: Parameters<Fixture["update"]>[0]): Promise<void> {
  const before = await page.evaluate(() => window.mobileChatQa.reads);
  await page.evaluate((kind) => window.mobileChatQa.update(kind), kind);
  await page.waitForFunction((before) => window.mobileChatQa.reads > before, before);
  await settled(page);
}
async function check(name: string, page: Page, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    results.push({ name, passed: true, geometry: await geometry(page) });
    console.log(`PASS ${name}`);
  }
  catch (cause) {
    failures.push(name);
    const measured = await geometry(page);
    results.push({ name, passed: false, geometry: measured, error: String(cause) });
    console.error(`FAIL ${name}: ${String(cause)} geometry=${JSON.stringify(measured)}`);
  }
  if (evidence) await page.screenshot({ path: join(evidence, `mobile-chat-${name.replaceAll(/[^a-z0-9]+/gi, "-")}.png`) });
}

try {
  if (evidence) mkdirSync(evidence, { recursive: true });
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const control = `<script>(() => {
    const pane = ${JSON.stringify(panes.infra)};
    const demoFetch = window.fetch;
    const DemoSocket = window.WebSocket;
    const sockets = new Set();
    const pending = [];
    let olderReply = null;
    const qa = window.mobileChatQa = { reads: 0, promptReads: 0, restored: null, managedState: null, terminalReads: 0, olderReads: 0, version: 0, submissions: [],
      releaseOlder() { if (!olderReply) throw new Error("No older page requested"); olderReply(); olderReply = null; },
      update(kind) {
        qa.version++;
        if (kind === "stream") turns[turns.length - 1].parts[0].text += "\\n\\nStreaming paragraph " + qa.version + ". A fictional answer grows while history is being read.";
        if (kind === "append") turns.push(turn("assistant", "Appended answer " + qa.version));
        for (const socket of sockets) {
          if (kind === "status") socket.push({ type: "pane-status", pane_id: pane, agent_status: qa.version % 2 ? "working" : "done" });
          socket.push({ type: "conversation-changed", pane_id: pane, signature: "mobile:" + qa.version });
        }
      },
      acknowledge(ok, code) {
        const send = pending.shift();
        if (!send) throw new Error("No fictional send to acknowledge");
        send.socket.push({ type: "submit-result", id: send.id, pane_id: pane, ok, ...(code ? { code, message: "Fictional delivery refusal" } : {}) });
      }
    };
    const Socket = function (...args) {
      const socket = new DemoSocket(...args);
      sockets.add(socket);
      const send = socket.send.bind(socket);
      socket.send = (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "submit" && frame.pane_id === pane) {
          qa.submissions.push({ id: frame.id, text: frame.text });
          pending.push({ ...frame, socket });
        } else send(raw);
      };
      return socket;
    };
    Socket.prototype = DemoSocket.prototype;
    Object.setPrototypeOf(Socket, DemoSocket);
    window.WebSocket = Socket;
    const turn = (role, text, n = 0) => ({ role, ts: new Date(1700000000000 + n * 1000).toISOString(), parts: [{ kind: "text", text }] });
    const rows = (start, count) => Array.from({ length: count }, (_, i) => turn((start + i) % 2 ? "assistant" : "user", "Fixture row " + (start + i) + "\\n\\n" + "A fictional paragraph with enough text to wrap on a phone. ".repeat(3), start + i));
    const turns = rows(40, 80);
    const json = (body) => Promise.resolve(Response.json(body));
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.searchParams.get("pane_id") !== pane) return demoFetch(input, init);
      if (url.pathname === "/api/pane/read") qa.terminalReads++;
      if (url.pathname === "/api/pane/prompt") { qa.promptReads++; return json({ prompt: null, suggestion: null, restored: qa.restored }); }
      if (url.pathname === "/api/pane/conversation") {
        qa.reads++;
        const managed = qa.managedState === null ? undefined : { id: "a".repeat(32), harness: "claude", generation: 1, state: qa.managedState, session_id: qa.managedState === "ready" ? "00000000-0000-4000-8000-000000000001" : null, reason: qa.managedState === "blocked" ? "blocked_agent_not_ready" : qa.managedState === "identity_pending" ? "identity_pending" : null };
        if (qa.managedState !== null && qa.managedState !== "ready") return json({ source: "scrollback", turns: [], managed_session: managed });
        const older = url.searchParams.has("before");
        if (older) qa.olderReads++;
        const answer = () => json({ source: "claude-transcript", history_id: "mobile-chat-synthetic", managed_session: managed, cursor: older ? null : "latest", activity: "working", turns: older ? rows(0, 40) : turns });
        return older ? new Promise((resolve) => { olderReply = () => resolve(answer()); }) : answer();
      }
      return demoFetch(input, init);
    };
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n${control}\n<script type="module"`));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false, autoSendQueued: false })));
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.infra)}&view=chat`);
        await page.locator(".conn-live").waitFor();
        await chat(page).locator(".chat-turn-agent").first().waitFor();
        await appFaces(page);
        await bottom(page);
        const jump = async () => {
          const button = page.locator(".pane-frame.is-current .chat-new-messages");
          if (await button.count()) await button.click();
          await bottom(page);
        };
        // Real Chromium touch scrolling (not a replacement scroll implementation).
        const cdp = await context.newCDPSession(page);
        const touchUp = async (pixels: number) => {
          const box = (await chat(page).boundingBox())!;
          const x = box.x + box.width / 2, y = box.y + box.height / 2;
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          for (let delta = 5; delta <= pixels; delta += 5) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + delta }] });
          }
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await settled(page);
          await chat(page).evaluate((node) => new Promise<void>((resolve, reject) => {
            const deadline = performance.now() + 5000;
            let previous = node.scrollTop, stable = 0;
            const tick = () => {
              if (performance.now() > deadline) { reject(new Error("Touch scroll did not settle")); return; }
              if (node.scrollTop === previous) stable++; else stable = 0;
              previous = node.scrollTop;
              if (stable >= 10) resolve(); else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }));
        };
        if (process.env.MOBILE_CHAT_CASE !== "composer") {
          await check("short upward touch inside 48px during update", page, async () => {
            const before = await geometry(page);
            await touchUp(30);
            const read = await geometry(page);
            assert.ok(read.gap > 1 && read.gap < 48, `short real touch leaves a gap within 48px: ${JSON.stringify(read)}`);
            await update(page, "status");
            await update(page, "stream");
            const after = await geometry(page);
            assert.ok(after.top <= before.top - 2, `reader not pulled back to bottom: ${JSON.stringify({ before, read, after })}`);
          });
          await jump();
          await check("upward input cancels queued follow before scroll event", page, async () => {
            const before = await geometry(page);
            await page.evaluate(() => {
              const node = document.querySelector<HTMLElement>(".pane-frame.is-current .chat-view")!;
              // Input and a read can arrive before the virtualizer's RAF-coalesced scroll callback.
              node.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [new Touch({ identifier: 1, target: node, clientX: 100, clientY: 200 })] }));
              node.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [new Touch({ identifier: 1, target: node, clientX: 100, clientY: 225 })] }));
              window.mobileChatQa.update("status");
            });
            await settled(page);
            await update(page, "stream");
            assert.ok((await geometry(page)).top <= before.top + 1, "updates cannot move down between upward input and the browser's scroll event");
            assert.ok((await geometry(page)).gap > 20, "a follow queued before the native scroll callback must yield to upward intent");
            await page.evaluate(() => document.querySelector(".pane-frame.is-current .chat-view")!.dispatchEvent(new TouchEvent("touchend", { bubbles: true })));
          });
          await jump();
          await check("upward gesture yields before mobile viewport resize", page, async () => {
            // Only mobile viewport geometry is controlled: the App and its ResizeObserver stay real.
            await bottom(page);
            // A stream may finish following between driver calls. Measure at the input boundary,
            // not in an earlier task whose still-valid follow can move before the gesture starts.
            await update(page, "stream");
            await bottom(page);
            const before = await page.evaluate(() => {
              const node = document.querySelector<HTMLElement>(".pane-frame.is-current .chat-view")!;
              const measured = { top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight };
              node.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [new Touch({ identifier: 1, target: node, clientX: 100, clientY: 200 })] }));
              node.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [new Touch({ identifier: 1, target: node, clientX: 100, clientY: 225 })] }));
              document.documentElement.style.setProperty("--app-height", "600px");
              return measured;
            });
            await settled(page);
            const after = await geometry(page);
            assert.ok(after.viewport < before.viewport, `the fixture must shrink the mobile viewport: ${JSON.stringify({ before, after })}`);
            assert.ok(after.top <= before.top + 1, `a viewport resize must yield to the upward gesture before the scroll callback: ${JSON.stringify({ before, after })}`);
            assert.ok(after.gap > 1, `the resized viewport must not resume following: ${JSON.stringify({ before, after })}`);
            await page.evaluate(() => {
              document.documentElement.style.removeProperty("--app-height");
              document.querySelector(".pane-frame.is-current .chat-view")!.dispatchEvent(new TouchEvent("touchend", { bubbles: true }));
            });
          });
          await page.evaluate(() => document.documentElement.style.removeProperty("--app-height"));
          await jump();
          await check("sustained history reading through stream and status refresh", page, async () => {
            await touchUp(200);
            const before = await geometry(page);
            for (const kind of ["append", "stream", "status", "stream", "status"] as const) await update(page, kind);
            const after = await geometry(page);
            assert.ok(Math.abs(after.top - before.top) < 2, JSON.stringify({ before, after }));
            await page.setViewportSize({ width: 390, height: 650 });
            await settled(page);
            assert.ok(Math.abs((await geometry(page)).top - before.top) < 2, "reading survives keyboard-sized viewport resize");
          });
          await check("pagination prepend preserves rendered anchor", page, async () => {
            await chat(page).evaluate((node) => {
              node.dispatchEvent(new WheelEvent("wheel", { deltaY: -10000, bubbles: true }));
              node.scrollTop = 40;
            });
            await settled(page);
            await page.waitForFunction(() => window.mobileChatQa.olderReads > 0);
            await settled(page);
            const anchor = await chat(page).evaluate((node) => {
              const top = node.getBoundingClientRect().top;
              const row = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")].filter((row) => row.getBoundingClientRect().bottom > top).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]!;
              return { key: row.dataset.chatRow!, offset: row.getBoundingClientRect().top - top };
            });
            await page.evaluate(() => window.mobileChatQa.releaseOlder());
            await page.locator(".pane-frame.is-current .chat-older").waitFor({ state: "hidden" });
            await settled(page);
            const prepended = await chat(page).evaluate((node, key) => node.querySelector<HTMLElement>(`[data-chat-row="${CSS.escape(key)}"]`)!.getBoundingClientRect().top - node.getBoundingClientRect().top, anchor.key);
            assert.ok(Math.abs(prepended - anchor.offset) < 2, `prepend: ${JSON.stringify({ anchor, prepended })}`);
            await update(page, "status");
            await update(page, "stream");
            const offset = await chat(page).evaluate((node, key) => node.querySelector<HTMLElement>(`[data-chat-row="${CSS.escape(key)}"]`)!.getBoundingClientRect().top - node.getBoundingClientRect().top, anchor.key);
            assert.ok(Math.abs(offset - anchor.offset) < 2, JSON.stringify({ anchor, offset }));
          });
          await check("explicit jump restores following and viewport resize", page, async () => {
            await jump();
            await update(page, "stream"); await bottom(page);
            await page.setViewportSize({ width: 390, height: 844 }); await bottom(page);
            await update(page, "append"); await bottom(page);
            await page.setViewportSize({ width: 420, height: 720 }); await bottom(page);
            await update(page, "status"); await bottom(page);
          });
        }
        if (process.env.MOBILE_CHAT_CASE !== "scroll") {
          const composer = page.locator(".pane-frame.is-current .composer-text");
          const note = page.locator(".pane-frame.is-current .composer-note");
          const send = async () => {
            const before = await page.evaluate(() => window.mobileChatQa.submissions.length);
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            await page.waitForFunction((n) => window.mobileChatQa.submissions.length > n, before);
          };
          const ack = async (ok: boolean, code?: string) => {
            await page.evaluate(([ok, code]) => window.mobileChatQa.acknowledge(ok, code), [ok, code] as const);
            await page.waitForFunction(() => !document.querySelector(".pane-frame.is-current .composer-send[aria-busy=true]"));
            await settled(page);
          };
          await check("unchanged successful send has no edit warning", page, async () => {
            await composer.fill("Unchanged successful message"); await send(); await ack(true);
            assert.equal(await composer.inputValue(), "");
            assert.equal(await note.count(), 0);
          });
          await check("restored draft withdrawal during send is not an edit", page, async () => {
            await page.evaluate(() => { window.mobileChatQa.restored = "Restored message to send again"; });
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".pane-frame.is-current .composer-text")?.value === "Restored message to send again");
            await send();
            const reads = await page.evaluate(() => { window.mobileChatQa.restored = null; return window.mobileChatQa.promptReads; });
            await page.waitForFunction((n) => window.mobileChatQa.promptReads > n, reads);
            await settled(page);
            const during = await composer.inputValue();
            await ack(true);
            assert.equal(await note.count(), 0, `unchanged restored send must not warn: ${JSON.stringify(await note.allTextContents())}`);
            assert.equal(during, "Restored message to send again", "automatic restored cleanup cannot edit the in-flight draft");
            assert.equal(await composer.inputValue(), "");
          });
          await check("withdrawn restored draft survives unconfirmed send", page, async () => {
            await page.evaluate(() => { window.mobileChatQa.restored = "Restored draft awaiting confirmation"; });
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".pane-frame.is-current .composer-text")?.value === "Restored draft awaiting confirmation");
            await send();
            const reads = await page.evaluate(() => { window.mobileChatQa.restored = null; return window.mobileChatQa.promptReads; });
            await page.waitForFunction((n) => window.mobileChatQa.promptReads > n, reads);
            await settled(page);
            await ack(false, "submit_partial");
            assert.equal(await composer.inputValue(), "Restored draft awaiting confirmation");
            assert.match(await note.innerText(), /Not confirmed/);
          });
          await check("real in-flight edits and appended text are retained", page, async () => {
            await composer.fill("Original message"); await send();
            await composer.fill("Revised message"); await ack(true);
            assert.equal(await composer.inputValue(), "Revised message");
            assert.match(await note.innerText(), /Your changes made while it was sending/);
            await composer.fill("Sent prefix"); await send();
            await composer.fill("Sent prefix plus unsent suffix"); await ack(true);
            assert.equal(await composer.inputValue(), " plus unsent suffix");
          });
          await check("Korean IME tap sends committed syllable once", page, async () => {
            await composer.fill("한글 작");
            await composer.dispatchEvent("compositionstart", { data: "작" });
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            const count = await page.evaluate(() => window.mobileChatQa.submissions.length);
            await composer.evaluate((node) => {
              node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "작성" }));
              const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
              setter.call(node, "한글 작성");
              node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "성" }));
            });
            await page.waitForFunction((n) => window.mobileChatQa.submissions.length > n, count);
            assert.equal(await page.evaluate(() => window.mobileChatQa.submissions.at(-1)?.text), "한글 작성");
            await ack(true);
            assert.equal(await composer.inputValue(), "");
            assert.equal(await note.count(), 0);
            assert.equal(await page.evaluate(() => window.mobileChatQa.submissions.length), count + 1);
          });
          await check("same-task Korean commit and send uses latest draft", page, async () => {
            await composer.fill("한글 초안");
            const before = await page.evaluate(() => window.mobileChatQa.submissions.length);
            await composer.evaluate((node) => {
              node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
              node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "수정" }));
              Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, "한글 수정");
              node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "수정" }));
              document.querySelector<HTMLButtonElement>(".pane-frame.is-current .composer-send")!.click();
            });
            await page.waitForFunction((n) => window.mobileChatQa.submissions.length > n, before);
            const sent = await page.evaluate(() => window.mobileChatQa.submissions.at(-1)?.text);
            await ack(true);
            assert.equal(sent, "한글 수정", "committed text, not the prior render, is sent");
            assert.equal(await composer.inputValue(), "", "an unchanged committed send is cleared");
            assert.equal(await note.count(), 0, "no spurious in-flight-edit warning");
          });
          await check("failed and unconfirmed sends retain draft", page, async () => {
            for (const code of ["agent_blocked", "submit_partial"]) {
              await composer.fill(`Keep draft ${code}`); await send(); await ack(false, code);
              assert.equal(await composer.inputValue(), `Keep draft ${code}`);
              assert.equal(await note.count(), 1);
            }
          });
          await check("managed trust startup waits then recovers in place", page, async () => {
            const frame = await page.locator(".pane-frame.is-current").elementHandle();
            for (const state of ["identity_pending", "blocked"] as const) {
              await page.evaluate((state) => { window.mobileChatQa.managedState = state; }, state);
              await update(page, "status");
              await page.locator(`[data-managed-state="${state}"]`).waitFor();
              assert.equal(await chat(page).locator(".chat-turn, .chat-terminal-fallback").count(), 0, "unproved native identity never leaks terminal or transcript content");
            }
            await page.evaluate(() => { window.mobileChatQa.managedState = "ready"; });
            await update(page, "status");
            await chat(page).locator(".chat-turn-agent").first().waitFor();
            assert.equal(await page.locator("[data-managed-state]").count(), 0);
            assert.equal(await page.evaluate(() => window.mobileChatQa.terminalReads), 0);
            assert.equal(await frame!.evaluate((node) => node.isConnected), true, "the same App pane recovers without a reload");
          });
        }
        assert.deepEqual(errors, [], "no App render errors");
      } finally { await context.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally {
  if (evidence) writeFileSync(join(evidence, "results.json"), JSON.stringify(results, null, 2) + "\n");
  rmSync(app, { recursive: true, force: true });
}
assert.deepEqual(failures, [], "real App mobile regressions");
