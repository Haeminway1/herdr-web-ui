/** The plan meters beside Settings, on a staged report: no real sign-in is read or sent. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import type { UsageReport } from "../shared/protocol.ts";
import { openSettingsPage } from "./settings-page.ts";

const at = (hours: number): string => new Date(Date.now() + hours * 3600_000).toISOString();
/** Built when it is asked for: its times, and the paces measured from them, hold however late in the run that is. */
const report = (): UsageReport => ({
  providers: [
    { id: "claude", key: "claude:u1", account: "me@example.com", plan: "max", problem: null, checked_at: at(0), windows: [
      // 2.8 hours into the session at 15%/h: lasts to the reset
      { kind: "session", scope: null, used_percent: 42, resets_at: at(2.2), starts_at: at(2.2 - 5) },
      // 86 hours into the week: runs out in about 2 days, 1.4 days before the reset
      { kind: "week", scope: null, used_percent: 63.4, resets_at: at(82), starts_at: at(82 - 168) },
      { kind: "week", scope: "Sonnet", used_percent: 5, resets_at: null, starts_at: null },
    ] },
    { id: "codex", key: "codex:work", account: "me@work.example", plan: "pro", problem: null, checked_at: at(0), windows: [
      { kind: "session", scope: null, used_percent: 12, resets_at: at(0.8), starts_at: at(0.8 - 5) },
      { kind: "week", scope: null, used_percent: 91, resets_at: at(99), starts_at: at(99 - 168) },
    ] },
    { id: "codex", key: "codex:home", account: "me@example.com", plan: "plus", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [
      { kind: "week", scope: null, used_percent: 30, resets_at: at(120), starts_at: null },
    ] },
    { id: "cursor", key: "cursor:c1", account: null, plan: "pro", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [{ kind: "month", scope: null, used_percent: 20, resets_at: at(300), starts_at: null }] },
    { id: "copilot", key: "copilot:me", account: "me", plan: "free", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [{ kind: "month", scope: "Chat", used_percent: 0, resets_at: at(34), starts_at: null }] },
    { id: "grok", key: "grok:g1", account: null, plan: null, problem: "rate_limited", checked_at: "2026-09-29T11:40:00Z", windows: [{ kind: "week", scope: null, used_percent: 0, resets_at: null, starts_at: null }] },
    { id: "antigravity", key: "antigravity@keychain", account: null, plan: null, problem: "expired", checked_at: null, windows: [] },
  ],
});

async function staged(context: BrowserContext): Promise<string[]> {
  const asked: string[] = [];
  await context.route("**/api/usage*", (route) => {
    asked.push(new URL(route.request().url()).search);
    return route.fulfill({ json: report() });
  });
  return asked;
}

export async function checkUsageMeters(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const asked = await staged(context);
    // fork deployment: the meters default to on at the top; this check starts from upstream's defaults
    // (only before anything is saved: the init script runs again on every load)
    await context.addInitScript(() => { try { if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ showUsage: false, usagePlacement: "footer" })); } catch { /* no storage */ } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    const strip = page.locator(".usage-strip");
    const settingsButton = page.locator(".sidebar-footer-row .sidebar-footer-action");
    const toggle = page.getByRole("switch", { name: "Show plan limits", exact: true });

    // off until chosen: nothing is shown and no sign-in is sent anywhere
    await settingsButton.waitFor();
    assert.equal(await strip.count(), 0);
    assert.deepEqual(asked, [], "no usage request before the user turns it on");
    await settingsButton.click();
    await openSettingsPage(page, "Subscription usage");
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await toggle.click();
    await page.keyboard.press("Escape");
    await strip.waitFor();

    // the pace is a setting of its own, off until chosen: no warning in the strip, no red hairline on a low share, no mark or rate in the popover
    assert.doesNotMatch(await strip.getAttribute("aria-label") ?? "", /Runs out/);
    assert.equal(await page.locator(".usage-chip.is-fast").count(), 0);
    await strip.click();
    await page.getByRole("dialog", { name: "Subscription usage", exact: true }).locator(".usage-row").first().waitFor();
    assert.equal(await page.locator(".usage-bar-pace, .usage-row-pace").count(), 0);
    await page.keyboard.press("Escape");
    await settingsButton.click();
    await openSettingsPage(page, "Subscription usage");
    await page.getByRole("switch", { name: "Show pace", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.locator(".usage-chip.is-fast").first().waitFor();

    // three chips and "+4" past four accounts, in the server's order, each its plan's week; one near its limit is red; two Codex accounts apart;
    // a week running out before its reset says when, and its hairline turns red while its share is still low
    assert.equal(await page.locator(".usage-chip").count(), 3);
    assert.equal(await page.locator(".usage-more").textContent(), "+4");
    assert.match(await strip.getAttribute("aria-label") ?? "",
      /^Subscription usage: Claude · me@example\.com 63% \(Runs out in 2d 1h\), Codex · me@work\.example 91% \(Runs out in 6h \d+m\), Codex · me@example\.com 30%, Cursor 20%, Copilot · me 0%, Grok 0%, Antigravity —$/);
    assert.equal(await page.locator(".usage-chip").nth(1).evaluate((chip) => chip.classList.contains("is-high")), true);
    assert.deepEqual(await page.locator(".usage-chip").evaluateAll((chips) => chips.map((chip) => chip.classList.contains("is-fast"))), [true, true, false]);
    assert.equal(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth), true, "the chips fit beside Settings");
    const [settings, meters] = await Promise.all([page.locator(".sidebar-footer-row .sidebar-footer-action").boundingBox(), strip.boundingBox()]);
    assert.ok(settings && meters && settings.x + settings.width <= meters.x, "Settings and the meters do not overlap");

    await strip.click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    assert.equal(await popover.locator(".usage-provider").count(), 7);
    assert.equal(await popover.getByRole("meter").count(), 9);
    assert.equal(await popover.locator(".usage-account").first().textContent(), "me@example.com");
    assert.equal(await popover.locator(".usage-row.is-high").count(), 1);
    // the pace of every window whose start is known: a marker where an even pace would be, the rate, and when it runs out if before the reset
    assert.equal(await popover.locator(".usage-bar-pace").count(), 4);
    const paces = await popover.locator(".usage-row-pace").allTextContents();
    [/^15%\/h$/, /^18%\/day · Runs out in 2d 1h$/, /^2\.\d%\/h$/, /^32%\/day · Runs out in 6h \d+m$/].forEach((pattern, index) => assert.match(paces[index] ?? "", pattern));
    assert.equal(paces.length, 4);
    const marker = () => popover.locator(".usage-bar-pace").first().evaluate((el) => parseFloat((el as HTMLElement).style.left));
    const usedMarker = await marker();
    assert.ok(usedMarker > 55 && usedMarker < 58, `a session 2.8 of 5 hours in puts the marker 56% along, not ${usedMarker}%`);
    assert.equal(await popover.locator(".usage-note.is-problem").count(), 1, "only the expired sign-in reads as an error");
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover.png") });
    }
    const refreshed = page.waitForRequest((request) => request.url().endsWith("/api/usage?refresh=1"));
    await popover.getByRole("button", { name: "Refresh", exact: true }).click();
    await refreshed;
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    assert.equal(await strip.evaluate((el) => el === document.activeElement), true, "Escape hands focus back to the strip");

    // Settings: what is left instead, an account hidden from the strip, another moved up
    const names = () => page.locator(".usage-popover .usage-provider").evaluateAll((sections) => sections.map((section) => section.getAttribute("aria-label")));
    await settingsButton.click();
    await openSettingsPage(page, "Subscription usage");
    await page.getByRole("button", { name: "Remaining", exact: true }).click();
    await page.getByRole("switch", { name: "Show Codex · me@work.example", exact: true }).click();
    await page.getByRole("button", { name: "Move Cursor up", exact: true }).click();
    await page.keyboard.press("Escape");
    assert.equal(await strip.getAttribute("aria-label"),
      "Subscription usage: Claude · me@example.com 37% left (Runs out in 2d 1h), Cursor 80% left, Codex · me@example.com 70% left, Copilot · me 100% left, Grok 100% left, Antigravity —");
    assert.deepEqual(await page.locator(".usage-chip-value").allTextContents(), ["37%", "80%", "70%"]);
    await strip.click();
    assert.deepEqual((await names()).slice(0, 3), ["Claude · me@example.com", "Cursor", "Codex · me@example.com"], "a hidden account is left out of the popover too");
    assert.equal(await popover.locator(".usage-provider").count(), 6);
    assert.equal(await popover.locator(".usage-row-value").first().textContent(), "58% left");
    const leftMarker = await marker();
    assert.ok(leftMarker > 42 && leftMarker < 45, `counting what is left, the marker sits where an even pace leaves 44%, not ${leftMarker}%`);
    if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover-left.png") });
    await page.keyboard.press("Escape");
    await settingsButton.click();
    await openSettingsPage(page, "Subscription usage");
    if (process.env.UI_EVIDENCE_DIR) {
      await page.getByRole("tabpanel", { name: "Subscription usage", exact: true }).screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-settings.png") });
    }
    // the session instead of the week: an account without one keeps the limit it has
    await page.locator('.segmented[aria-label="Limit shown"]').getByRole("button", { name: "Session", exact: true }).click();
    await page.keyboard.press("Escape");
    assert.match(await strip.getAttribute("aria-label") ?? "", /^Subscription usage: Claude · me@example.com 58% left, Cursor 80% left, Codex · me@example.com 70% left,/);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}") as { usageHidden?: string[]; usageCount?: string; usageGlance?: string });
    assert.deepEqual([stored.usageHidden, stored.usageCount, stored.usageGlance], [["codex:work"], "left", "session"]);

    // turned off in Settings: gone, and no longer asked for
    await settingsButton.click();
    await openSettingsPage(page, "Subscription usage");
    await toggle.click();
    await strip.waitFor({ state: "detached" });
    const before = asked.length;
    await page.reload();
    await page.locator(".sidebar-footer").waitFor();
    assert.equal(asked.length, before, "a hidden strip asks for nothing");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }

  // on a phone the popover opens inside the drawer and stays on screen
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" });
  try {
    await staged(phone);
    // fork deployment: name the placement too, since the fork's default puts the meters at the top
    await phone.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ showUsage: true, usagePlacement: "footer" })));
    const page = await phone.newPage();
    await page.goto(origin);
    await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
    await page.locator(".usage-strip").click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    const box = await popover.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390, "the popover stays inside the phone's screen");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover-phone.png") });

    // Settings on the phone: every account row fits its card, controls included
    await page.keyboard.press("Escape");
    await page.locator(".sidebar-footer-row .sidebar-footer-action").click();
    await openSettingsPage(page, "Subscription usage");
    const accounts = page.locator(".usage-accounts");
    await accounts.scrollIntoViewIfNeeded();
    assert.equal(await accounts.locator(".usage-accounts-row").count(), 7);
    assert.equal(await accounts.evaluate((card) => [...card.querySelectorAll(".usage-accounts-row")].every((row) => row.scrollWidth <= row.clientWidth)), true, "each account row fits the phone");
    if (process.env.UI_EVIDENCE_DIR) {
      await page.getByRole("tabpanel", { name: "Subscription usage", exact: true }).screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-settings-phone.png") });
    }
  } finally {
    await phone.close();
  }
  console.log("PASS plan meters beside Settings: accounts, order, hiding, used or left, overflow, popover, refresh, Escape, off switch and phone fit");

  // at the top of the list on a phone: one poller, each account told apart, the PCs still in reach
  const top = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" });
  try {
    const asked = await staged(top);
    await top.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ showUsage: true, usagePlacement: "top" })));
    const page = await top.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
    const panel = page.getByRole("region", { name: "Subscription usage", exact: true });
    await panel.waitFor();
    assert.equal(await page.locator(".usage-strip").count(), 0, "the strip beside Settings gives way to the panel");
    assert.equal(asked.length, 1, "only the panel asks for usage");
    // a phone's drawer shows one line of percents first; the rows unfold from it
    assert.equal(await panel.locator(".usage-panel-chip").count(), 7, "one chip per account on the folded line");
    assert.equal(await panel.locator(".usage-panel-line").evaluate((line) => line.scrollWidth <= line.clientWidth), true, "the folded line fits the phone");
    await panel.getByRole("button", { name: "Show plan limits" }).click();
    const rows = panel.locator(".usage-panel-row");
    assert.equal(await rows.count(), 7);
    assert.match(await rows.nth(1).textContent() ?? "", /Codex.*me@work\.example/, "two Codex accounts are told apart, in the server's order (#408)");
    assert.match(await rows.nth(2).textContent() ?? "", /Codex.*me@example\.com/);
    assert.equal(await rows.evaluateAll((all) => all.every((row) => row.scrollWidth <= row.clientWidth)), true, "each row fits the phone");
    // a slowed-down or signed-out account says so in its row, as the footer chip dims: not only once opened
    assert.equal(await panel.locator(".usage-panel-row.has-problem").count(), 2);
    assert.deepEqual(await panel.locator(".usage-panel-problem").allTextContents(),
      ["Grok asked to slow down. These are the last numbers.", "Sign-in expired. Open Antigravity to renew it."]);
    assert.equal(await panel.locator(".usage-panel-problem.is-problem").count(), 1, "only the expired sign-in reads as an error");
    assert.equal(await panel.getByRole("button", { name: /Grok asked to slow down.*Sign-in expired\. Open Antigravity/ }).count(), 1, "the reasons are in the rows' accessible name");
    assert.equal(await panel.locator(".usage-panel-row.has-problem .usage-panel-value").first().evaluate((el) => Number(getComputedStyle(el).opacity) < 1), true, "old numbers dim");

    const toggle = panel.locator(".usage-panel-rows");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    const detail = page.locator(`[id="${await toggle.getAttribute("aria-controls")}"]`);
    assert.equal(await detail.getByRole("meter").count(), 9);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const list = await page.locator(".machine-list").boundingBox();
    assert.ok(list && list.height >= 200, `the PCs keep room under the open panel (${list?.height}px)`);
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-panel-phone-open.png") });
    }
    await toggle.click();
    if (process.env.UI_EVIDENCE_DIR) {
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-panel-phone.png") });
      // the accounts with a problem sit at the bottom of the panel's scroll
      await panel.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-panel-phone-problems.png") });
    }

    // back beside Settings: the panel stops asking and the strip takes over
    await page.locator(".sidebar-footer-row .sidebar-footer-action").click();
    await openSettingsPage(page, "Subscription usage");
    await page.getByRole("button", { name: "Beside Settings", exact: true }).click();
    await page.keyboard.press("Escape");
    // Settings closed the drawer, and a closed drawer is hidden (#683): open it again to see the strip
    await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
    await page.locator(".usage-strip").waitFor();
    assert.equal(await page.locator(".usage-panel").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await top.close();
  }
  console.log("PASS plan meters at the top of the list: one poller, accounts apart, phone fit, open panel leaves the PCs room, back beside Settings");

  // a wide sidebar: the same three views, a click further each (rows, every limit, one line),
  // the view kept on this device
  const wide = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await staged(wide);
    await wide.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ showUsage: true, usagePlacement: "top" })));
    const page = await wide.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    const panel = page.getByRole("region", { name: "Subscription usage", exact: true });
    const rows = panel.locator(".usage-panel-rows");
    await rows.waitFor();
    assert.equal(await panel.locator(".usage-panel-line").count(), 0, "a wide sidebar starts on the rows");
    await rows.click();
    assert.equal(await rows.getAttribute("aria-expanded"), "true", "a click opens every limit");
    await rows.click();
    const line = panel.locator(".usage-panel-line");
    await line.waitFor();
    assert.equal(await panel.locator(".usage-panel-chip").count(), 7, "and the next one folds to one line, a percent per account");
    assert.equal(await line.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "the line fits the sidebar");
    if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-panel-line-desktop.png") });
    await page.reload();
    await line.waitFor();
    assert.equal(await panel.locator(".usage-panel-rows").count(), 0, "the line is kept across a reload");
    await line.click();
    await rows.waitFor();
    await panel.getByRole("button", { name: "Fold plan limits", exact: true }).click();
    await line.waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await wide.close();
  }
  console.log("PASS plan meters at the top of a wide sidebar: line, rows and every limit a click apart, the view kept");
}
