/** Real React + browser regressions with controlled HTTP timing. No herdr panes are touched. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { VOICE_DEFAULTS, type VoiceStatus } from "../shared/voice.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-history-browser-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const releases: Array<() => void> = [];
try {
  const build = await Bun.build({ entrypoints: ["scripts/chat-history-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/ws") return new Response(null, { status: 404 });
    if (path.endsWith("/pane/commands")) return Response.json({ commands: [] });
    // a desktop's composer asks whether dictation can work here before it shows the mic
    if (path === "/api/voice") return Response.json({ configured: false, source: null, ...VOICE_DEFAULTS } satisfies VoiceStatus);
    return path === "/" ? new Response('<html><head><link rel="stylesheet" href="/chat-history-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-history-fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } }) : new Response(Bun.file(join(root, path.slice(1))));
  } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  // The fixture follows the browser's language; its text assertions below use English.
  const page = await browser.newPage({ locale: "en-US" });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
  let epoch = "one", newest = "old newest", before: string | null = "one:100";
  let holdOlder = false, olderRequested = false;
  let product = false;
  /** product panes ("machine/pane") whose conversation requests wait for the script, and those that fail */
  const held = new Set<string>(), failing = new Set<string>();
  const pending: Array<{ key: string; answer: (status: number) => Promise<void> }> = [];
  type HeldReply = { key: string; reply: (status: number, body: object) => Promise<void> };
  const heldReplies: HeldReply[] = [];
  const hold = new Set<string>();
  const waitHeld = async (key: string) => {
    await page.waitForFunction((name) => (window as unknown as { heldRequests: string[] }).heldRequests?.includes(name), key);
    assert.ok(heldReplies.some((item) => item.key === key), `missing held request ${key}`);
    return { reply: async (status: number, body: object) => {
      hold.delete(key);
      const requests = heldReplies.filter((item) => item.key === key);
      for (const request of requests) await request.reply(status, body);
      for (const request of requests) heldReplies.splice(heldReplies.indexOf(request), 1);
    } };
  };
  await page.addInitScript(() => { (window as unknown as { heldRequests: string[] }).heldRequests = []; });
  await page.route("**/api/**/pane/read?*", async (route) => {
    if (!hold.has("scrollback")) return route.fulfill({ json: { read: { text: "CURRENT SCROLLBACK", truncated: false } } });
    heldReplies.push({ key: "scrollback", reply: async (status, body) => { await route.fulfill({ status, json: body }); } });
    await page.evaluate(() => (window as unknown as { heldRequests: string[] }).heldRequests.push("scrollback"));
  });
  const user = (text: string) => ({ role: "user", ts: text, parts: [{ kind: "text", text }] });
  await page.route("**/api/**/conversation?*", async (route) => {
    const url = new URL(route.request().url());
    if (product) {
      const pane = url.searchParams.get("pane_id") ?? url.searchParams.get("pane") ?? "";
      const key = `${/\/api\/machines\/([^/]+)\//.exec(url.pathname)?.[1] ?? "local"}/${pane}`;
      const answer = (status: number) => status === 200
        ? route.fulfill({ json: key === "local/devin" ? { source: "devin-transcript", history_id: "synthetic-devin-session", cursor: null, turns: [
          user("Synthetic Devin prompt"),
          { role: "assistant", ts: null, parts: [
            { kind: "tool", name: "synthetic_tool", summary: "synthetic_tool", input: "{}", output: "synthetic result" },
            { kind: "text", text: "Synthetic Devin answer" },
          ] },
        ] } : { source: key === "local/claude" ? "claude-transcript" : "omp-transcript", history_id: key, cursor: null, turns: [user(key === "local/claude" ? "Synthetic Claude prompt" : `history ${key}`)] } })
        : route.fulfill({ status, json: { error: { code: "unavailable", message: "conversation unavailable" } } });
      // answered as it arrives unless its pane is held: a poll an abandoned mount left
      // behind can then never stand in for the request an assertion waits on
      if (held.has(key)) await new Promise<void>((resolve) => pending.push({ key, answer: (status) => answer(status).finally(resolve) }));
      else await answer(failing.has(key) ? 503 : 200);
      return;
    }
    const key = `${url.pathname.includes("/machines/") ? "remote" : "local"}:${url.searchParams.get("pane_id")}`;
    if (hold.has(key)) {
      heldReplies.push({ key, reply: async (status, body) => { await route.fulfill({ status, json: body }); } });
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
  // a settled turn's work is folded: open the block, then its row
  await page.locator(".work-block-head").click();
  await page.locator(".work-row-head").click();
  await page.locator(".chat-tool-more").click();
  const requestIndex = await page.evaluate(() => window.qa.requests.length - 1);
  epoch = "three"; newest = "newest after another clear";
  await refresh();
  await page.getByText(newest, { exact: true }).waitFor();
  await page.waitForFunction((i) => window.qa.requests[i].signal.aborted, requestIndex);
  await page.evaluate((i) => window.qa.requests[i].resolve("STALE TOOL OUTPUT"), requestIndex);
  // the cleared history brought a new turn, folded like any settled one
  assert.equal(await page.locator(".work-block-head").getAttribute("aria-expanded"), "false");
  await page.locator(".work-block-head").click();
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
  // a settled turn's work is folded (upstream #458): open it to see the tool row
  await page.locator(".work-block-head").last().click();
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

  // Exercise the actual product owner. A profiler observes every committed DOM, not just the final frame.
  const select = async (pane: string, machine: string, agent?: string) => {
    product = true;
    // the log is cleared in the task that switches: no commit of the pane being left slips in between
    await page.evaluate(([p, m, a]) => { window.qa.commits.length = 0; window.qa.select(p!, m!, a); }, [pane, machine, agent]);
  };
  /** The expected chat is up, and no commit since the switch showed the other pane's. */
  const shows = async (expected: string, forbidden: string) => {
    await page.getByText(`history ${expected}`, { exact: true }).waitFor();
    const commits = await page.evaluate(() => window.qa.commits);
    assert.ok(commits.length > 0, "profiler recorded product commits");
    assert.ok(commits.every((turns) => !turns.some((turn) => turn.includes(`history ${forbidden}`))), `stale ${forbidden} in intermediate commits: ${JSON.stringify(commits)}`);
  };
  await select("a", "local");
  await page.getByText("history local/a", { exact: true }).waitFor();
  await select("b", "local");
  await shows("local/b", "local/a");
  await select("a", "local");
  await shows("local/a", "local/b");
  await select("a", "remote-pc");
  await shows("remote-pc/a", "local/a");
  // A late success and a late error from B must neither replace nor erase A's chat.
  for (const status of [200, 503]) {
    held.add("remote-pc/b");
    const ended = await page.evaluate(() => window.qa.answered.filter((key) => key === "remote-pc/b").length);
    await select("b", "remote-pc");
    const deadline = Date.now() + 10_000;
    while (!pending.some((request) => request.key === "remote-pc/b")) {
      assert.ok(Date.now() < deadline, "missing delayed B request");
      await Bun.sleep(20);
    }
    await select("a", "remote-pc");
    await page.getByText("history remote-pc/a", { exact: true }).waitFor();
    held.delete("remote-pc/b");
    for (const request of pending.splice(0)) await request.answer(status);
    // B's request has ended in the page (answered, or cancelled when B left) and two frames
    // have passed: whatever it could change is committed
    await page.waitForFunction((count) => window.qa.answered.filter((key) => key === "remote-pc/b").length > count, ended);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await shows("remote-pc/a", "remote-pc/b");
    assert.equal(await page.getByText("history remote-pc/a", { exact: true }).count(), 1, "late response preserves active chat");
    assert.equal(await page.locator(".chat-inline-error").count(), 0, "late error belongs to the abandoned pane");
  }
  failing.add("remote-pc/b");
  await select("b", "remote-pc");
  await page.locator(".chat-inline-error").waitFor();
  assert.equal(await page.getByText("history remote-pc/a", { exact: true }).count(), 0, "unavailable chat cannot show another pane's history");
  assert.ok((await page.evaluate(() => window.qa.commits)).every((turns) => !turns.some((turn) => turn.includes("history remote-pc/a"))), "no commit of the unavailable chat showed another pane's history");
  await select("devin", "local", "devin");
  await page.getByText("Synthetic Devin prompt", { exact: true }).waitFor();
  await page.getByText("Synthetic Devin answer", { exact: true }).waitFor();
  await page.locator(".work-block-head").click();
  assert.equal(await page.locator(".work-row-name").filter({ hasText: "synthetic_tool" }).count(), 1);
  await page.locator(".work-row-head").click();
  await page.getByText("synthetic result", { exact: true }).waitFor();
  await select("claude", "local", "claude");
  await page.getByText("Synthetic Claude prompt", { exact: true }).waitFor();
  assert.equal(await page.getByText("Synthetic Devin answer", { exact: true }).count(), 0);
  assert.ok((await page.evaluate(() => window.qa.commits)).every((turns) => !turns.some((turn) => turn.includes("Synthetic Devin"))), "switch to Claude cannot commit Devin history");
  assert.deepEqual(errors, []);
  console.log("PASS synthetic Devin bubbles and tools render; switching to Claude clears Devin history");
  console.log("PASS product pane commits across A→B→A, another PC, and late or failed answers");
} finally {
  releases.forEach((release) => release());
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
