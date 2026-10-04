/** Real React + browser regressions with controlled HTTP timing. No herdr panes are touched. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const root = mkdtempSync(join(tmpdir(), "herdr-history-browser-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const releases: Array<() => void> = [];
try {
  const build = await Bun.build({ entrypoints: ["scripts/chat-history-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    return path === "/" ? new Response('<html><head><link rel="stylesheet" href="/chat-history-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-history-fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } }) : new Response(Bun.file(join(root, path.slice(1))));
  } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  let epoch = "one", newest = "old newest", before: string | null = "one:100";
  let holdOlder = false, olderRequested = false;
  type HeldReply = { key: string; reply: (status: number, body: object) => Promise<void> };
  const held: HeldReply[] = [];
  const hold = new Set<string>();
  const waitHeld = async (key: string) => {
    await page.waitForFunction((name) => (window as unknown as { heldRequests: string[] }).heldRequests?.includes(name), key);
    assert.ok(held.some((item) => item.key === key), `missing held request ${key}`);
    return { reply: async (status: number, body: object) => {
      hold.delete(key);
      const requests = held.filter((item) => item.key === key);
      for (const request of requests) await request.reply(status, body);
      for (const request of requests) held.splice(held.indexOf(request), 1);
    } };
  };
  await page.addInitScript(() => { (window as unknown as { heldRequests: string[] }).heldRequests = []; });
  await page.route("**/api/**/pane/read?*", async (route) => {
    if (!hold.has("scrollback")) return route.fulfill({ json: { read: { text: "CURRENT SCROLLBACK", truncated: false } } });
    held.push({ key: "scrollback", reply: async (status, body) => { await route.fulfill({ status, json: body }); } });
    await page.evaluate(() => (window as unknown as { heldRequests: string[] }).heldRequests.push("scrollback"));
  });
  const user = (text: string) => ({ role: "user", ts: text, parts: [{ kind: "text", text }] });
  await page.route("**/api/**/conversation?*", async (route) => {
    const url = new URL(route.request().url());
    const key = `${url.pathname.includes("/machines/") ? "remote" : "local"}:${url.searchParams.get("pane_id")}`;
    if (hold.has(key)) {
      held.push({ key, reply: async (status, body) => { await route.fulfill({ status, json: body }); } });
      await page.evaluate((name) => (window as unknown as { heldRequests: string[] }).heldRequests.push(name), key);
      return;
    }
    const captured = epoch;
    const cursor = url.searchParams.get("before") ?? url.searchParams.get("from");
    if (cursor && !cursor.startsWith(`${epoch}:`)) {
      await route.fulfill({ status: 409, json: { error: { code: "history_changed", message: "reload history" } } });
      return;
    }
    if (url.searchParams.has("before")) {
      olderRequested = true;
      if (holdOlder) await new Promise<void>((resolve) => releases.push(resolve));
      await route.fulfill({ json: { source: "omp-transcript", history_id: captured, cursor: null, turns: [user("old earlier")] } });
    } else {
      const tool = { role: "assistant", ts: "reused", parts: [{ kind: "tool", name: "Read", summary: "same", input: "{}", output: "preview", output_ref: "reused", output_size: 9000 }] };
      await route.fulfill({ json: { source: "omp-transcript", history_id: epoch, cursor: before, turns: newest ? [user(newest), tool] : [] } });
    }
  });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.getByText("old newest", { exact: true }).waitFor();
  const refresh = () => page.evaluate(() => window.qa.refresh());
  const output = page.locator("#output");
  await page.locator("#fetch-output").click();
  assert.equal(await page.evaluate(() => window.qa.requests.length), 1, "duplicate load deduplicated");
  await page.evaluate(() => window.qa.target("/qa-output?pane=b&ref=x", "one"));
  await page.waitForFunction(() => window.qa.requests[0].signal.aborted);
  await page.evaluate(() => window.qa.requests[0].resolve("STALE A"));
  assert.equal(await output.textContent(), "idle:");
  await page.locator("#fetch-output").click();
  await page.evaluate(() => window.qa.requests[1].resolve("B result"));
  await page.waitForFunction(() => document.querySelector("#output")?.textContent === "idle:B result");
  await page.evaluate(() => window.qa.target("/qa-output?pane=b&ref=y", "one"));
  await page.waitForFunction(() => document.querySelector("#output")?.textContent === "idle:");
  await page.locator("#fetch-output").click();
  await page.evaluate(() => window.qa.target("/qa-output?pane=b&ref=y", "two"));
  await page.waitForFunction(() => window.qa.requests[2].signal.aborted);
  await page.evaluate(() => window.qa.requests[2].reject());
  assert.equal(await output.textContent(), "idle:");
  console.log("PASS duplicate requests, pane/ref/history changes, abort, late success and late failure");

  // Start an older-page request, then observe clear before it completes.
  holdOlder = true;
  await page.locator(".chat-older").click();
  while (!olderRequested) await Bun.sleep(20);
  epoch = "two"; newest = ""; before = null;
  await refresh();
  await page.getByText("No conversation yet — say something below", { exact: true }).waitFor();
  releases.splice(0).forEach((release) => release());
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".chat-turn").count(), 0, "late older page cannot revive cleared history");
  assert.equal(await page.locator(".chat-older").count(), 0);
  console.log("PASS clear while earlier page is in flight and empty history before a new prompt");

  newest = "new newest";
  await refresh();
  await page.getByText(newest, { exact: true }).waitFor();
  await page.locator(".work-row-head").click();
  await page.locator(".chat-tool-more").click();
  const requestIndex = await page.evaluate(() => window.qa.requests.length - 1);
  epoch = "three"; newest = "newest after another clear";
  await refresh();
  await page.getByText(newest, { exact: true }).waitFor();
  await page.waitForFunction((i) => window.qa.requests[i].signal.aborted, requestIndex);
  await page.evaluate((i) => window.qa.requests[i].resolve("STALE TOOL OUTPUT"), requestIndex);
  await page.locator(".work-row-head").click();
  assert.equal(await page.getByText("STALE TOOL OUTPUT", { exact: true }).count(), 0);
  assert.equal(await page.locator(".chat-tool-more").count(), 1);
  // A remote PC with the same pane/tool id is a distinct target too.
  await page.locator(".chat-tool-more").click();
  const remoteIndex = await page.evaluate(() => window.qa.requests.length - 1);
  await page.evaluate(() => window.qa.chat("a", "remote-pc"));
  await page.waitForFunction((i) => window.qa.requests[i].signal.aborted, remoteIndex);
  await page.evaluate((i) => window.qa.requests[i].reject(), remoteIndex);
  await page.getByText(newest, { exact: true }).waitFor();
  assert.equal(await page.getByText("Couldn't load the whole output — retry", { exact: true }).count(), 0);
  // Already loaded older history must be discarded when a held cursor gets 409.
  epoch = "four"; newest = "loaded history newest"; before = "four:100"; holdOlder = false;
  await page.evaluate(() => window.qa.chat("b"));
  await page.getByText(newest, { exact: true }).waitFor();
  await page.locator(".chat-older").click();
  await page.getByText("old earlier", { exact: true }).waitFor();
  epoch = "five"; newest = "after held cursor reset"; before = null;
  await refresh();
  await page.getByText(newest, { exact: true }).waitFor();
  assert.equal(await page.getByText("old earlier", { exact: true }).count(), 0);
  assert.equal(await page.locator(".chat-older").count(), 0);

  // A stale cursor discovered by the Earlier button also triggers a fresh poll.
  epoch = "six"; newest = "before older cursor reset"; before = "six:100";
  await refresh();
  await page.getByText(newest, { exact: true }).waitFor();
  epoch = "seven"; newest = "after older cursor reset"; before = null;
  await page.locator(".chat-older").click();
  await page.getByText(newest, { exact: true }).waitFor();
  assert.equal(await page.locator(".chat-older").count(), 0);
  console.log("PASS held-cursor and older-page 409 recovery discard history and immediately reload");
  await page.evaluate(() => window.qa.chat("a"));
  await page.locator('.chat-view[aria-label="conversation of a"]').waitFor();
  await page.getByText(newest, { exact: true }).waitFor();
  await page.evaluate(() => { window.qa.frames.length = 0; });
  // The first render after a switch must not expose the previous pane's transcript,
  // even when a previous request answers late or the new pane has not answered yet.
  const assertLoadingOnly = async (previous: string) => {
    assert.equal(await page.getByText(previous, { exact: true }).count(), 0);
    assert.equal(await page.locator(".chat-turn, .chat-terminal-fallback, .chat-empty, .chat-inline-error").count(), 0);
    assert.equal(await page.getByText("Loading conversation…", { exact: true }).count(), 1);
  };
  hold.add("local:b");
  await page.evaluate(() => window.qa.chat("b", "local", "claude"));
  const staleB = await waitHeld("local:b");
  await assertLoadingOnly(newest);
  assert.deepEqual(await page.evaluate((old) => window.qa.frames.filter((frame) => frame.pane === "conversation of b" && frame.text.includes(old)), newest), [], "no committed B frame may contain A's turn");
  hold.add("local:a");
  await page.evaluate(() => window.qa.chat("a", "local", "codex"));
  const freshA = await waitHeld("local:a");
  await assertLoadingOnly(newest);
  await staleB.reply(503, { error: { code: "unavailable", message: "STALE PANE B ERROR" } });
  await assertLoadingOnly("STALE PANE B TURN");
  assert.equal(await page.getByText("STALE PANE B ERROR", { exact: false }).count(), 0);
  await freshA.reply(200, { source: "omp-transcript", history_id: "fresh-a", cursor: null, turns: [user("FRESH PANE A TURN")] });
  await page.getByText("FRESH PANE A TURN", { exact: true }).waitFor();
  assert.equal(await page.getByText("STALE PANE B TURN", { exact: true }).count(), 0);

  hold.add("local:a");
  await refresh();
  const staleA = await waitHeld("local:a");
  hold.add("remote:a");
  await page.evaluate(() => window.qa.chat("a", "remote-pc", "claude"));
  const remoteA = await waitHeld("remote:a");
  await assertLoadingOnly("FRESH PANE A TURN");
  await staleA.reply(200, { source: "omp-transcript", history_id: "stale-a", cursor: null, turns: [user("STALE LOCAL MACHINE TURN")] });
  await assertLoadingOnly("STALE LOCAL MACHINE TURN");
  await remoteA.reply(503, { error: { code: "unavailable", message: "REMOTE HISTORY UNAVAILABLE" } });
  await page.getByRole("alert").waitFor();
  assert.equal(await page.getByText("FRESH PANE A TURN", { exact: true }).count(), 0);
  assert.equal(await page.locator(".chat-turn, .chat-terminal-fallback").count(), 0);
  // A real scrollback response is delayed separately from the conversation response.
  hold.add("local:b");
  await page.evaluate(() => window.qa.chat("b"));
  const fallback = await waitHeld("local:b");
  hold.add("scrollback");
  await fallback.reply(200, { source: "scrollback", history_id: "fallback-b", turns: [] });
  const transcript = await waitHeld("scrollback");
  await assertLoadingOnly("FRESH PANE A TURN");
  await transcript.reply(200, { read: { text: "CURRENT SCROLLBACK", truncated: false } });
  await page.getByText("CURRENT SCROLLBACK", { exact: false }).waitFor();
  assert.equal(await page.getByText("FRESH PANE A TURN", { exact: true }).count(), 0);
  await page.evaluate(() => { window.qa.frames.length = 0; });
  hold.add("local:a");
  await page.evaluate(() => window.qa.chat("a", "local", "codex"));
  const afterFallback = await waitHeld("local:a");
  await assertLoadingOnly("Conversation unavailable — show terminal output");
  assert.deepEqual(await page.evaluate(() => window.qa.frames.filter((frame) => frame.pane === "conversation of a" && frame.text.includes("Conversation unavailable — show terminal output"))), [], "no committed A frame may contain B's fallback");
  await afterFallback.reply(200, { source: "omp-transcript", history_id: "after-fallback", cursor: null, turns: [user("AFTER FALLBACK A TURN")] });
  await page.getByText("AFTER FALLBACK A TURN", { exact: true }).waitFor();
  await page.evaluate(() => { window.qa.frames.length = 0; });
  hold.add("local:a");
  await page.evaluate(() => window.qa.chat("a", "local", "codex", "new-session"));
  const newSession = await waitHeld("local:a");
  await assertLoadingOnly("AFTER FALLBACK A TURN");
  assert.deepEqual(await page.evaluate(() => window.qa.frames.filter((frame) => frame.pane === "conversation of a" && frame.text.includes("AFTER FALLBACK A TURN"))), [], "new agent session on the same pane cannot paint the old session");
  await newSession.reply(200, { source: "omp-transcript", history_id: "new-session", cursor: null, turns: [user("NEW SESSION A TURN")] });
  await page.getByText("NEW SESSION A TURN", { exact: true }).waitFor();
  hold.add("local:b");
  await page.evaluate(() => window.qa.chat("b", "local", "devin", "devin-session"));
  const devin = await waitHeld("local:b");
  await assertLoadingOnly("NEW SESSION A TURN");
  await devin.reply(200, { source: "devin-transcript", history_id: "devin-session", cursor: null, turns: [
    user("Synthetic Devin prompt"),
    { role: "assistant", ts: null, parts: [
      { kind: "tool", name: "synthetic_tool", summary: "synthetic_tool", input: "{}", output: "synthetic result" },
      { kind: "text", text: "Synthetic Devin answer" },
    ] },
  ] });
  await page.getByText("Synthetic Devin prompt", { exact: true }).waitFor();
  await page.getByText("Synthetic Devin answer", { exact: true }).waitFor();
  assert.equal(await page.locator(".work-row-name").filter({ hasText: "synthetic_tool" }).count(), 1);
  assert.equal(await page.getByText("NEW SESSION A TURN", { exact: true }).count(), 0);
  hold.add("local:a");
  await page.evaluate(() => window.qa.chat("a", "local", "claude", "claude-session"));
  const claude = await waitHeld("local:a");
  await assertLoadingOnly("Synthetic Devin answer");
  await claude.reply(200, { source: "claude-transcript", history_id: "claude-session", cursor: null, turns: [user("Synthetic Claude prompt")] });
  await page.getByText("Synthetic Claude prompt", { exact: true }).waitFor();
  assert.equal(await page.getByText("Synthetic Devin answer", { exact: true }).count(), 0);
  console.log("PASS Devin bubbles and tools render; switching to Claude clears Devin history");
  console.log("PASS rapid A→B→A, same-pane machine/session switch, stale error, delayed scrollback and genuine unavailable error");
  assert.deepEqual(errors, []);
  console.log("PASS reused tool ids after clear, machine switch and unmount cancellation; no browser errors");
} finally {
  releases.forEach((release) => release());
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
