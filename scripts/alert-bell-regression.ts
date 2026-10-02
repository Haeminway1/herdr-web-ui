import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/** The bell keeps the alerts this device heard: a count of new ones, a list, and a click opens the pane. */
export async function checkAlertBell(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-bell-"));
  const workspaces: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const panes: string[] = [];
    for (const name of ["open", "other"]) {
      const cwd = join(root, name);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-bell-${name}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
    }
    const [openPane, otherPane] = panes as [string, string];
    const report = (pane: string, state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
    await report(openPane, "idle");
    await report(otherPane, "idle");
    await context.addInitScript(() => {
      if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertDone: "off" }));
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(openPane)}`);
    await page.locator(".conn-live").waitFor();
    await report(otherPane, "working");
    await page.locator(`.pane-item:has(.pane-select[title^="${otherPane} —"]) [data-status="working"]`).first().waitFor({ state: "attached" });
    await report(otherPane, "blocked");
    // the suite's other panes may have said something too: this one is among the new
    await page.bringToFront();
    await page.locator(".alert-bell-count").waitFor({ timeout: 15_000 }).catch(async (error) => {
      console.log("bell state", await page.evaluate(() => ({ log: localStorage.getItem("herdr-web-ui:alert-log"), bell: document.querySelector(".alert-bell-button")?.outerHTML.slice(0, 200) })));
      throw error;
    });
    await page.locator(".alert-bell-button").click();
    const item = page.locator(".alert-bell-item.is-new", { hasText: "other" }).first();
    await item.waitFor();
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "alert-bell.png"), clip: { x: 1280 - 420, y: 0, width: 420, height: 260 } });
    assert.match(await item.innerText(), /Needs input/);
    await item.click();
    await page.locator(`.pane-select[title^="${otherPane} —"][aria-current="true"]`).waitFor({ state: "attached" });
    assert.equal(await page.locator(".alert-bell-count").count(), 0, "seen once the list was opened");
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await page.getByRole("button", { name: "Alerts", exact: true }).click();
    assert.ok(await page.locator(".alert-bell-item", { hasText: "other" }).count() >= 1, "the list outlives a reload");
    assert.deepEqual(errors, []);
    console.log("PASS the bell keeps the alerts heard, counts the new ones, and opens their pane");
  } finally {
    await context.close();
    for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
