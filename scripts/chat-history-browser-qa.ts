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
    if (path === "/ws") return new Response(null, { status: 404 });
    if (path.endsWith("/pane/commands")) return Response.json({ commands: [] });
    return path === "/" ? new Response('<html><head><link rel="stylesheet" href="/chat-history-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-history-fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } }) : new Response(Bun.file(join(root, path.slice(1))));
  } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
  let epoch = "one", newest = "old newest", before: string | null = "one:100";
  let holdOlder = false, olderRequested = false;
  let product = false, productSession = "one";
  const pending: Array<{ pane: string; machine: string; session: string; answer: (status?: number) => Promise<void> }> = [];
  const user = (text: string) => ({ role: "user", ts: text, parts: [{ kind: "text", text }] });
  await page.route("**/api/**/conversation?*", async (route) => {
    const url = new URL(route.request().url());
    if (product) {
      const pane = url.searchParams.get("pane_id") ?? url.searchParams.get("pane") ?? "";
      const machine = /\/api\/machines\/([^/]+)\//.exec(url.pathname)?.[1] ?? "local";
      const session = productSession;
      await new Promise<void>((resolve) => pending.push({ pane, machine, session, answer: async (status = 200) => {
        try {
          if (status !== 200) await route.fulfill({ status, json: { error: { code: "unavailable", message: "conversation unavailable" } } });
          else await route.fulfill({ json: { source: "omp-transcript", history_id: session, cursor: null, turns: [user(`history ${machine}/${pane}/${session}`)] } });
        } finally { resolve(); }
      } }));
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
  assert.deepEqual(errors, []);
  console.log("PASS reused tool ids after clear, machine switch and unmount cancellation; no browser errors");

  // Exercise the actual product owner. A profiler observes every committed DOM, not just the final frame.
  const select = async (pane: string, machine: string, session: string) => {
    productSession = session;
    await page.evaluate(([p, m, s]) => window.qa.select(p, m, s), [pane, machine, session]);
    product = true;
  };
  const answer = async (pane: string, machine: string, session: string, status = 200) => {
    const started = Date.now();
    while (!pending.some((request) => request.pane === pane && request.machine === machine && request.session === session)) {
      assert.ok(Date.now() - started < 10_000, `missing conversation request ${machine}/${pane}/${session}`);
      await Bun.sleep(20);
    }
    const matching = pending.filter((request) => request.pane === pane && request.machine === machine && request.session === session);
    for (const request of matching) {
      pending.splice(pending.indexOf(request), 1);
      await request.answer(status);
    }
  };
  const assertNoStaleCommits = async (expected: string, forbidden: string) => {
    const commits = await page.evaluate(() => window.qa.commits);
    assert.ok(commits.length > 0, "profiler recorded product commits");
    assert.ok(commits.every((turns) => !turns.some((turn) => turn.includes(forbidden))), `stale ${forbidden} in intermediate commits: ${JSON.stringify(commits)}`);
    await page.getByText(expected, { exact: true }).waitFor();
  };
  await select("a", "local", "first");
  await answer("a", "local", "first");
  await page.getByText("history local/a/first", { exact: true }).waitFor();
  await page.evaluate(() => { window.qa.commits.length = 0; });
  await select("b", "local", "first");
  await answer("b", "local", "first");
  await assertNoStaleCommits("history local/b/first", "history local/a/first");
  await page.evaluate(() => { window.qa.commits.length = 0; });
  await select("a", "local", "first");
  await answer("a", "local", "first");
  await assertNoStaleCommits("history local/a/first", "history local/b/first");
  await page.evaluate(() => { window.qa.commits.length = 0; });
  await select("a", "remote-pc", "first");
  await answer("a", "remote-pc", "first");
  await assertNoStaleCommits("history remote-pc/a/first", "history local/a/first");
  await page.evaluate(() => { window.qa.commits.length = 0; });
  await select("a", "remote-pc", "restart");
  await answer("a", "remote-pc", "restart");
  await assertNoStaleCommits("history remote-pc/a/restart", "history remote-pc/a/first");
  // A late success and a late error from B must neither replace nor erase A's chat.
  for (const status of [200, 503]) {
    await page.evaluate(() => { window.qa.commits.length = 0; });
    await select("b", "remote-pc", "restart");
    const started = Date.now();
    while (!pending.some((request) => request.pane === "b" && request.machine === "remote-pc")) {
      assert.ok(Date.now() - started < 10_000, "missing delayed B request");
      await Bun.sleep(20);
    }
    await select("a", "remote-pc", "restart");
    await answer("a", "remote-pc", "restart");
    await answer("b", "remote-pc", "restart", status);
    await assertNoStaleCommits("history remote-pc/a/restart", "history remote-pc/b/restart");
    assert.equal(await page.getByText("history remote-pc/a/restart", { exact: true }).count(), 1, "late response preserves active chat");
    assert.equal(await page.locator(".chat-inline-error").count(), 0, "late error belongs to the abandoned pane");
  }
  await select("b", "remote-pc", "unavailable");
  await answer("b", "remote-pc", "unavailable", 503);
  await page.locator(".chat-inline-error").waitFor();
  assert.equal(await page.getByText("history remote-pc/a/restart", { exact: true }).count(), 0, "unavailable chat cannot show another pane's history");
  assert.deepEqual(errors, []);
  console.log("PASS product pane identity commits across A→B→A, machine and session restart");
} finally {
  releases.forEach((release) => release());
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
