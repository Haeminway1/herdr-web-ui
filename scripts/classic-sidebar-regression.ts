import assert from "node:assert/strict";
import type { Browser } from "playwright-core";

import { sessionSnapshot } from "../server/herdr/client.ts";

/**
 * fork: the classic sidebar (ClassicSidebar.tsx) the user keeps through every upstream sync —
 * panes grouped by folder, a row per pane, and the row's rename and close actions on hover.
 */
export async function checkClassicSidebar(browser: Browser, origin: string, paneId: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    // set once: a reload below changes the grouping in storage and keeps it
    await context.addInitScript(() => { if (!sessionStorage.getItem("qa-classic")) { sessionStorage.setItem("qa-classic", "1"); localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ sidebarLayout: "classic", sidebarGrouping: "directory" })); } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    assert.ok(pane?.cwd, "the pane has a folder");
    // the classic bar, and no upstream Agents list beside it
    await page.locator(".sidebar-shell.is-classic .sidebar-new-session").waitFor();
    assert.equal(await page.locator(".sidebar-shell.is-classic .sidebar-add-pc").count(), 1, "Add PC sits beside New session");
    assert.equal(await page.locator(".agent-sidebar, .agent-select").count(), 0, "no Agents list in the classic sidebar");
    // the pane's row sits under its folder's group
    const group = page.locator(".cl-directory-group").filter({ has: page.locator(`.cl-pane-select[title^="${paneId} —"]`) });
    await group.waitFor();
    assert.equal(await group.getAttribute("data-directory"), pane.cwd, "grouped by the pane's folder");
    const row = group.locator(".cl-pane-item").filter({ has: page.locator(`.cl-pane-select[title^="${paneId} —"]`) });
    await row.locator(".cl-pane-select").click();
    assert.equal(await row.locator(".cl-pane-select").getAttribute("aria-current"), "true");
    // hover shows rename and close; close asks before it closes
    await row.hover();
    const rename = row.getByRole("button", { name: /^Rename / });
    const close = row.locator(".cl-pane-close");
    assert.equal(await rename.isVisible(), true, "rename on hover");
    assert.equal(await close.isVisible(), true, "close on hover");
    await close.click();
    assert.equal(await close.textContent(), "sure?", "the first click only arms close");
    await page.keyboard.press("Escape");
    // a rename lands in herdr, then the old name comes back
    const before = pane.label ?? "";
    await row.hover();
    await rename.click();
    const input = row.getByRole("textbox", { name: "Pane name" });
    await input.fill("classic-qa");
    await input.press("Enter");
    for (const deadline = Date.now() + 5000; (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId)?.label !== "classic-qa";) {
      assert.ok(Date.now() < deadline, "the rename reaches herdr");
      await page.waitForTimeout(100);
    }
    await row.hover();
    await rename.click();
    await input.fill(before);
    await input.press("Enter");
    // a folder folds and unfolds
    // found by its folder: folded, the group no longer holds the pane's row
    const header = page.locator(`.cl-directory-group[data-directory="${pane.cwd}"] .cl-directory-header`);
    await header.click();
    assert.equal(await header.getAttribute("aria-expanded"), "false");
    await header.click();
    assert.equal(await header.getAttribute("aria-expanded"), "true");
    // the attention inbox rows keep the classic row look
    assert.equal(await page.locator(".needs-input .pane-select").count(), 0, "inbox rows use the classic row classes");
    // the default grouping: a row per session, the repository's folder on top, no group headers
    await page.evaluate(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ sidebarLayout: "classic", sidebarGrouping: "repo" })));
    await page.reload();
    const repoRow = page.locator(".cl-pane-item").filter({ has: page.locator(`.cl-pane-select[title^="${paneId} —"]`) });
    await repoRow.waitFor();
    assert.equal(await page.locator(".cl-directory-group, .cl-workspace-header").count(), 0, "no folder or workspace headers");
    assert.equal(await repoRow.locator(".cl-pane-title").textContent(), pane.cwd.split("/").filter(Boolean).at(-1), "the repository's folder names the row");
    await repoRow.hover();
    assert.equal(await repoRow.getByRole("button", { name: /^Rename / }).isVisible(), true, "rename on hover by repository too");
    // the PC list scrolls under the wheel: the nested list never keeps it
    assert.equal(await page.locator(".machine-workspaces .cl-sidebar-list").evaluate((el) => getComputedStyle(el).overscrollBehaviorY), "auto");
    assert.deepEqual(errors, []);
    console.log("PASS classic sidebar: folder groups, a row per pane, hover rename and close, folding, a row per repository, scroll");
  } finally { await context.close(); }
  // a phone: the classic header keeps the pane's title beside its mark, and the alert panel
  // stays on screen wherever the bell sits
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" });
  try {
    await phone.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ sidebarLayout: "classic" })));
    const page = await phone.newPage();
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    const title = page.locator(".app-header.is-classic .context-title-text");
    await title.waitFor();
    assert.ok((await title.boundingBox())!.width > 40, "the title keeps room beside the mark");
    assert.equal(await page.locator(".app-header.is-classic .header-more").isVisible(), false, "no More button in the classic phone header");
    await page.locator(".alert-bell-button").first().click();
    const panel = await page.locator(".alert-bell-panel").boundingBox();
    assert.ok(panel && panel.x >= 0 && panel.x + panel.width <= 390, `the alert panel stays on screen: ${JSON.stringify(panel)}`);
    console.log("PASS classic phone header: title beside the mark, alert panel on screen");
  } finally { await phone.close(); }
}
