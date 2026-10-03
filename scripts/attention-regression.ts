import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { herdrRpc, paneRename, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

/**
 * The attention inbox against real herdr status changes: work shows under Working (folded to a
 * count), its finish under To read, opening the pane reads it (on the server, for every device),
 * and a pane that finishes while it is open on screen never shows there.
 */
export async function checkAttentionInbox(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-attention-"));
  const workspaces: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const panes: string[] = [];
    for (const suffix of ["reader", "answer"]) {
      const cwd = join(root, suffix);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-attention-${suffix}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
    }
    const [readerPane, answerPane] = panes as [string, string];
    await paneRename(answerPane, "Attention answer");
    const report = (state: string) => herdrRpc("pane.report_agent", { pane_id: answerPane, source: "manual", agent: "claude", state });
    await report("idle");
    await herdrRpc("pane.report_agent", { pane_id: readerPane, source: "manual", agent: "claude", state: "idle" });

    await context.addInitScript(() => {
      if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertDone: "off" }));
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(readerPane)}`);
    await page.locator(".conn-live").waitFor();
    const toRead = page.getByRole("region", { name: "To read", exact: true });
    const working = page.getByRole("region", { name: "Working", exact: true });
    const answerRow = (region: typeof toRead) => region.getByRole("button", { name: /Attention answer/ });
    const answerState = async () => ((await page.evaluate(async () => (await (await fetch("/api/session")).json()) as { snapshot: SessionSnapshot })).snapshot.panes as HerdrPane[]).find((pane) => pane.pane_id === answerPane)?.attention;

    // work going on: folded to a count, its rows one tap away
    await report("working");
    await working.waitFor();
    const toggle = working.getByRole("button", { expanded: false });
    await toggle.click();
    await answerRow(working).waitFor();
    console.log("PASS work going on folds under Working and opens");

    // finished while another pane is open: to read, newest first, and on the server too
    await report("idle");
    await answerRow(toRead).waitFor();
    await answerRow(working).waitFor({ state: "detached" });
    const finished = await answerState();
    assert.ok(finished?.finished_at, "the server stamped the finish");
    assert.equal(finished.seen_at, null);
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "attention-live.png") });
    }
    console.log("PASS a finished pane shows under To read");

    // opening it reads it: it leaves To read here, and the server keeps the read
    await answerRow(toRead).click();
    await page.locator(`.pane-select[title^="${answerPane} —"][aria-current="true"]`).waitFor({ state: "attached" });
    await answerRow(toRead).waitFor({ state: "detached" });
    const read = await answerState();
    assert.ok(read?.seen_at && Date.parse(read.seen_at) >= Date.parse(read.finished_at!), "the server kept the read");
    console.log("PASS opening a pane reads it, on the server");

    // finishing while it is open on screen: read as it happens, never listed
    await report("working");
    await answerRow(working).waitFor();
    await report("idle");
    await page.waitForFunction(async ({ pane, before }) => {
      const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { panes: { pane_id: string; attention?: { finished_at: string; seen_at: string | null } }[] } };
      const state = snapshot.panes.find((candidate) => candidate.pane_id === pane)?.attention;
      return !!state && state.finished_at > before && state.seen_at !== null && state.seen_at >= state.finished_at;
    }, { pane: answerPane, before: read.finished_at! }, { polling: 250 });
    assert.equal(await answerRow(toRead).count(), 0, "a pane finishing in front of the user is read already");
    console.log("PASS a pane that finishes while open is read at once");
    assert.deepEqual(errors, []);

    if (process.env.UI_EVIDENCE_DIR) await evidence(browser, origin, readerPane, process.env.UI_EVIDENCE_DIR);
  } finally {
    await context.close();
    for (const id of workspaces) await workspaceClose(id).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

/** Screenshots with a full inbox on a desktop and a phone: a roster of stand-in panes, no live events. */
async function evidence(browser: Browser, origin: string, readerPane: string, dir: string): Promise<void> {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  const stand = (id: string, label: string, agent: string, agent_status: string, attention?: HerdrPane["attention"]) => ({ id, label, agent, agent_status, attention });
  const roster = [
    stand("qa-ask", "deploy check", "claude", "blocked"),
    stand("qa-read-1", "api refactor", "codex", "done", { finished_at: minutesAgo(1), seen_at: null, preview: "Done: the auth middleware now reads the device cookie once per request; 14 tests pass." }),
    stand("qa-read-2", "release notes", "claude", "done", { finished_at: minutesAgo(18), seen_at: null, preview: "I drafted the 0.3.44 notes and left two questions inline for you." }),
    stand("qa-read-3", "flaky test hunt", "pi", "idle", { finished_at: minutesAgo(95), seen_at: minutesAgo(200), preview: "Found it: the watcher test races the debounce; fixed with a fake clock." }),
    stand("qa-work-1", "migration", "claude", "working"),
    stand("qa-work-2", "docs pass", "codex", "working"),
  ];
  for (const [width, height, name] of [[1280, 800, "attention-desktop.png"], [393, 852, "attention-phone.png"]] as const) {
    const phone = width < 768;
    const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    try {
      await context.addInitScript(() => {
        localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertDone: "off" }));
        localStorage.setItem("herdr-web-ui:pc-collapsed:local", "1");
      });
      await context.route("**/api/machines/events", (route) => route.abort());
      await context.route("**/api/machines", async (route) => {
        const body = await (await route.fetch()).json();
        const local = body.machines.find((machine: { id: string }) => machine.id === "local");
        const reader = local.snapshot.panes.find((pane: HerdrPane) => pane.pane_id === readerPane);
        local.name = "studio";
        local.snapshot.panes = [reader, ...roster.map(({ id, ...pane }) => ({ ...reader, ...pane, pane_id: id }))];
        local.snapshot.workspaces = local.snapshot.workspaces.filter((workspace: { workspace_id: string }) => workspace.workspace_id === reader.workspace_id);
        await route.fulfill({ json: { machines: [local] } });
      });
      const page: Page = await context.newPage();
      await page.goto(`${origin}/?pane=${encodeURIComponent(readerPane)}`);
      // a closed phone drawer is inert: the row is waited for in the page, not the accessibility tree
      await page.locator(".attention-to-read .pane-title", { hasText: "api refactor" }).waitFor({ state: "attached" });
      // the herdr version in the footer: health has answered, so the header says nothing of herdr
      await page.locator(".sidebar-brandline .pill").waitFor({ state: "attached" });
      if (phone) {
        await page.locator('[aria-controls="workspace-drawer"]').click();
        await page.waitForFunction(() => (document.getElementById("workspace-drawer")?.getBoundingClientRect().x ?? -1) >= 0);
      }
      await page.screenshot({ path: join(dir, name) });
    } finally { await context.close(); }
  }
}
