import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const iphoneUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const evidence = (phase: string) => join(process.env.UI_EVIDENCE_DIR ?? tmpdir(), `herdr-island-${phase}.png`);

async function islandFixture(context: BrowserContext, inset = 59, standalone = true): Promise<void> {
  await context.addInitScript((enabled) => {
    Object.defineProperty(navigator, "standalone", { configurable: true, get: () => enabled });
  }, standalone);
  // Chromium does not supply iOS env(safe-area-inset-top); inject the probe's measured inset.
  await context.addInitScript((top) => {
    const style = document.createElement("style");
    style.textContent = `.droplet-probe { padding-top: ${top}px !important; }`;
    const overlay = document.createElement("div");
    overlay.id = "qa-physical-island";
    overlay.style.cssText = "position:fixed;top:11px;left:50%;transform:translateX(-50%);width:126px;height:37px;border-radius:25px;background:#000;z-index:2147483647;pointer-events:none";
    document.addEventListener("DOMContentLoaded", () => {
      document.head.append(style);
      document.body.append(overlay);
    }, { once: true });
  }, inset);
}

async function islandScreenshot(page: Page, phase: string): Promise<void> {
  await page.screenshot({ path: evidence(phase), animations: "allow" });
}

async function geometry(page: Page) {
  return page.locator(".droplet-card").evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });
}

async function assertKeyline(page: Page, theme: string): Promise<void> {
  const { shadow, color, radius, height } = await page.locator(".droplet-card").evaluate((element) => {
    const style = getComputedStyle(element);
    const colorProbe = document.createElement("span");
    colorProbe.style.color = "var(--droplet-keyline)";
    document.body.append(colorProbe);
    const color = getComputedStyle(colorProbe).color;
    colorProbe.remove();
    return { shadow: style.boxShadow, color, radius: parseFloat(style.borderTopLeftRadius), height: element.getBoundingClientRect().height };
  });
  assert.match(shadow, /0px 0px 0px 1px inset(?:,|$)/, `${theme} island has a normal-state inset 1px keyline: ${shadow}`);
  assert.ok(shadow.includes(color), `${theme} keyline uses the theme color: ${shadow}, ${color}`);
  assert.ok(radius >= 14 && radius <= height / 2 + 1, `${theme} island retains a rounded capsule/banner silhouette: ${radius}px / ${height}px`);
}

/**
 * In-app alerts on a phone-sized page: real herdr status changes reach the open app, which
 * drops a card for a pane other than the open one (and none for the open one). A tap opens
 * that pane; a flick up puts one away; one left alone goes by itself.
 */
export async function checkDroplet(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-droplet-"));
  const workspaces: string[] = [];
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: "en-US", userAgent: iphoneUA });
  try {
    await islandFixture(context);
    const panes: string[] = [];
    for (const suffix of ["open", "other"]) {
      const cwd = join(root, suffix);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-droplet-${suffix}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
    }
    const [openPane, otherPane] = panes as [string, string];
    const report = (pane: string, state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
    await report(openPane, "idle");
    await report(otherPane, "idle");

    await context.addInitScript(() => {
      // finished turns stay quiet here: putting a pane back to idle between steps reads as one
      if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertDone: "off" }));
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(openPane)}`);
    await page.locator(".conn-live").waitFor();
    const droplet = page.locator(".droplet");
    const card = page.locator(".droplet-card");
    const selected = () => page.evaluate(() => new URLSearchParams(location.search).get("pane") ?? JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? localStorage.getItem("herdr-web-ui:selection") ?? "null")?.pane_id);
    // the app must have seen the pane work before it waits: a wait first seen is no news
    const seen = (pane: string, status: string) => page.locator(`.pane-item:has(.pane-select[title^="${pane} —"]) [data-status="${status}"]`).first().waitFor({ state: "attached" });
    const block = async (pane: string) => {
      // the alert shows only in a focused window: with the suite's other pages open, this one must be in front
      await page.bringToFront();
      await report(pane, "working");
      await seen(pane, "working");
      await report(pane, "blocked");
    };

    // the open pane: the user is looking at it already
    await block(openPane);
    await Bun.sleep(1_200);
    assert.equal(await droplet.count(), 0, "no in-app alert for the pane already open");
    console.log("PASS no in-app alert for the open pane");

    await block(otherPane);
    await card.waitFor({ state: "attached" });
    const start = await geometry(page);
    assert.ok(start.y >= 9 && start.y <= 14, `island starts at physical camera: ${JSON.stringify(start)}`);
    assert.ok(start.width < 300, `entry starts compact: ${JSON.stringify(start)}`);
    await islandScreenshot(page, "start");
    await page.waitForFunction((width) => {
      const element = document.querySelector(".droplet-card");
      const current = element?.getBoundingClientRect().width ?? 0;
      return current > width + 5 && current < 380;
    }, start.width, { timeout: 1_000, polling: "raf" });
    const middle = await geometry(page);
    assert.ok(middle.width > start.width + 5 && middle.width < 380, `island grows during entry: ${JSON.stringify({ start, middle })}`);
    assert.ok(middle.y >= 9 && middle.y <= 14 && Math.abs(middle.x + middle.width / 2 - 196.5) <= 1, `intermediate frame stays anchored at camera centre/top: ${JSON.stringify(middle)}`);
    await assertKeyline(page, "dark intermediate");
    await islandScreenshot(page, "mid");
    assert.match((await card.getAttribute("aria-label")) ?? "", /Needs input/);
    assert.equal(await droplet.getAttribute("data-kind"), "blocked");
    // The shell grows from the real camera, but its content must stay below the camera.
    await Bun.sleep(1_800); // the springs settle: the drop's fall and the card's spread overshoot first
    const box = (await card.boundingBox())!;
    const header = (await page.locator(".app-header").boundingBox())!;
    assert.ok(box.y >= 9 && box.y <= 14 && box.height >= 100 && box.height <= 125, `expanded island geometry ${JSON.stringify(box)}`);
    const camera = (await page.locator("#qa-physical-island").boundingBox())!;
    assert.equal(await page.evaluate(() => document.elementFromPoint(196, 30)?.closest(".droplet-card") !== null), true, "camera fixture must not intercept island hit testing");
    for (const selector of [".droplet-mark", ".droplet-title", ".droplet-detail", ".droplet-dot"]) {
      const content = (await page.locator(selector).boundingBox())!;
      assert.ok(content.y >= camera.y + camera.height + 4, `${selector} overlaps camera: ${JSON.stringify({ camera, content })}`);
    }
    assert.ok(header.y + header.height < box.y + box.height, "island expands over header while content clears camera");
    assert.ok(Math.abs(box.x + box.width / 2 - 196.5) <= 1, `card centre ${box.x + box.width / 2}`);
    assert.ok(box.width <= 393 - 24 && box.width > 300, `card width ${box.width}`);
    await assertKeyline(page, "dark expanded");
    await islandScreenshot(page, "expanded");
    await card.tap();
    await page.locator('.droplet[data-phase="out"]').waitFor({ state: "attached" });
    await page.waitForTimeout(260);
    const exit = await geometry(page);
    assert.ok(exit.width < box.width - 5 && exit.width >= 126, `exit shrinks toward camera: ${JSON.stringify(exit)}`);
    await islandScreenshot(page, "exit");
    await page.waitForFunction(() => {
      const width = document.querySelector(".droplet-card")?.getBoundingClientRect().width;
      return width !== undefined && width <= 160;
    }, null, { timeout: 800, polling: "raf" });
    const compact = await geometry(page);
    assert.ok(compact.width < exit.width && compact.y >= 9 && compact.y <= 14, `exit returns to camera: ${JSON.stringify(compact)}`);
    await islandScreenshot(page, "compact");
    await droplet.waitFor({ state: "detached" });
    await page.locator(`.pane-select[title^="${otherPane} —"][aria-current="true"]`).waitFor({ state: "attached", timeout: 5_000 });
    assert.equal(await selected(), otherPane, "a tap opens the pane it is about");
    console.log("PASS an in-app alert drops in for another pane, and a tap opens it");

    const light = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: "en-US", userAgent: iphoneUA });
    try {
      await islandFixture(light);
      await light.addInitScript(() => {
        localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertDone: "off", theme: "light" }));
      });
      const lightPage = await light.newPage();
      lightPage.on("pageerror", (error) => errors.push(error.message));
      await lightPage.goto(`${origin}/?pane=${encodeURIComponent(openPane)}`);
      await lightPage.locator(".conn-live").waitFor();
      await report(otherPane, "idle");
      await lightPage.bringToFront();
      await report(otherPane, "working");
      await lightPage.locator(`.pane-item:has(.pane-select[title^="${otherPane} —"]) [data-status="working"]`).first().waitFor({ state: "attached" });
      await report(otherPane, "blocked");
      await lightPage.locator(".droplet-card").waitFor({ state: "visible" });
      await lightPage.waitForFunction(() => {
        const card = document.querySelector(".droplet-card");
        const body = document.querySelector(".droplet-body");
        return (card?.getBoundingClientRect().width ?? 0) > 360
          && Number(getComputedStyle(body!).opacity) > 0.95;
      });
      assert.equal(await lightPage.locator("html").getAttribute("data-theme"), "light");
      await assertKeyline(lightPage, "light expanded");
      await islandScreenshot(lightPage, "light-expanded");
    } finally {
      await light.close();
    }

    // a flick up puts it away, and opens nothing
    await report(openPane, "idle");
    await block(openPane);
    await card.waitFor({ state: "visible", timeout: 5_000 });
    await Bun.sleep(700);
    const flick = (await card.boundingBox())!;
    await page.mouse.move(flick.x + flick.width / 2, flick.y + flick.height / 2);
    await page.mouse.down();
    await page.mouse.move(flick.x + flick.width / 2, flick.y + flick.height / 2 - 40, { steps: 4 });
    await page.mouse.up();
    await droplet.waitFor({ state: "detached", timeout: 4_000 }); // the drop folds back up on its springs
    assert.equal(await selected(), otherPane, "a flick up opens nothing");
    console.log("PASS a flick up puts an in-app alert away");

    // left alone, it goes by itself
    await report(openPane, "idle");
    await block(openPane);
    await card.waitFor({ state: "visible" });
    const shown = Date.now();
    await droplet.waitFor({ state: "detached", timeout: 11_000 });
    const lasted = Date.now() - shown;
    // 0.28s in, 5s held, then the drop folds back up on its springs
    assert.ok(lasted > 5_000 && lasted < 9_000, `stayed ${lasted}ms`);
    console.log("PASS an in-app alert goes by itself");

    const quiet = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: "en-US", userAgent: iphoneUA, reducedMotion: "reduce" });
    try {
      await islandFixture(quiet);
      const quietPage = await quiet.newPage();
      quietPage.on("pageerror", (error) => errors.push(error.message));
      await quietPage.goto(`${origin}/?pane=${encodeURIComponent(openPane)}`);
      await quietPage.locator(".conn-live").waitFor();
      const quietCard = quietPage.locator(".droplet-card");
      await report(otherPane, "idle");
      await quietPage.bringToFront();
      await report(otherPane, "working");
      await quietPage.locator(`.pane-item:has(.pane-select[title^="${otherPane} —"]) [data-status="working"]`).first().waitFor({ state: "attached" });
      await report(otherPane, "blocked");
      await quietCard.waitFor({ state: "attached" });
      await quietPage.waitForFunction(() => (document.querySelector(".droplet-card")?.getBoundingClientRect().width ?? 0) > 300);
      const geometry = async () => quietCard.evaluate((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      });
      const start = await geometry();
      assert.ok(start.y >= 9 && start.y <= 14 && start.height >= 100, `reduced-motion island geometry ${JSON.stringify(start)}`);
      await islandScreenshot(quietPage, "reduced");
      await quietPage.waitForTimeout(65);
      const middle = await geometry();
      await quietPage.waitForTimeout(250);
      const end = await geometry();
      assert.deepEqual(middle, start, "reduced-motion entry has no intermediate geometry change");
      assert.deepEqual(end, start, "reduced-motion entry has no final geometry change");
      await quietPage.waitForFunction(() => Number(getComputedStyle(document.querySelector(".droplet-card")!).opacity) > 0.95);
      await quietCard.evaluate((element) => (element as HTMLElement).click());
      await quietPage.locator('.droplet[data-phase="out"]').waitFor({ state: "attached" });
      const exitStart = await geometry();
      await quietPage.waitForTimeout(65);
      const exitMiddle = await geometry();
      const fadingOpacity = await quietCard.evaluate((element) => Number(getComputedStyle(element).opacity));
      assert.deepEqual(exitStart, start, "reduced-motion exit starts at expanded geometry");
      assert.deepEqual(exitMiddle, start, "reduced-motion exit has no intermediate geometry change");
      assert.ok(fadingOpacity > 0 && fadingOpacity < 1, `reduced-motion exit fades in place: ${fadingOpacity}`);
      await quietPage.locator(".droplet").waitFor({ state: "detached" });
      console.log("PASS reduced-motion entry and exit keep geometry fixed at intermediate frames");
    } finally {
      await quiet.close();
    }

    // Resizing for the virtual keyboard keeps the island at the camera; rotation falls back
    // below the header even though the UA and simulated inset have not changed.
    await page.setViewportSize({ width: 393, height: 520 });
    await report(openPane, "idle");
    await block(openPane);
    await card.waitFor({ state: "visible" });
    await page.waitForTimeout(850);
    assert.ok((await geometry(page)).y <= 14, "keyboard-height resize keeps portrait island at camera");
    await card.tap();
    await droplet.waitFor({ state: "detached" });
    await page.setViewportSize({ width: 852, height: 393 });
    await report(otherPane, "idle");
    await block(otherPane);
    await card.waitFor({ state: "visible" });
    await page.waitForTimeout(850);
    const landscape = await geometry(page);
    const landscapeHeader = (await page.locator(".app-header").boundingBox())!;
    assert.ok(landscape.y >= Math.max(59, landscapeHeader.y + landscapeHeader.height) + 12 - 1, `landscape falls below header: ${JSON.stringify(landscape)}`);
    assert.ok(landscape.height >= 67 && landscape.height <= 70, `landscape fallback height ${landscape.height}`);
    await islandScreenshot(page, "landscape");
    await card.tap();
    await droplet.waitFor({ state: "detached" });

    const tabs = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: "en-US", userAgent: iphoneUA });
    try {
      await islandFixture(tabs, 59, false);
      await tabs.addInitScript(() => {
        if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertDone: "off" }));
      });
      const tab = await tabs.newPage();
      tab.on("pageerror", (error) => errors.push(error.message));
      await tab.goto(`${origin}/?pane=${encodeURIComponent(openPane)}`);
      await tab.locator(".conn-live").waitFor();
      await report(otherPane, "idle");
      await tab.bringToFront();
      await report(otherPane, "working");
      await tab.locator(`.pane-item:has(.pane-select[title^="${otherPane} —"]) [data-status="working"]`).first().waitFor({ state: "attached" });
      await report(otherPane, "blocked");
      await tab.locator(".droplet-card").waitFor({ state: "visible" });
      await tab.waitForTimeout(850);
      const browserCard = await geometry(tab);
      const browserHeader = (await tab.locator(".app-header").boundingBox())!;
      assert.ok(browserCard.y >= Math.max(59, browserHeader.y + browserHeader.height) + 12 - 1, `browser tab falls below header: ${JSON.stringify(browserCard)}`);
      assert.ok(browserCard.height >= 67 && browserCard.height <= 70, `browser fallback height ${browserCard.height}`);
      await islandScreenshot(tab, "browser");
    } finally {
      await tabs.close();
    }

    // turned off in Settings: none
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}");
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ ...settings, alertInApp: false }));
    });
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await report(openPane, "idle");
    await block(openPane);
    await Bun.sleep(1_200);
    assert.equal(await droplet.count(), 0, "no in-app alert when turned off");
    console.log("PASS in-app alerts turned off stay off");

    // with a mouse, the same alert is a toast in the bottom-right corner, not a drop
    const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    try {
      await desk.addInitScript(() => {
        if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertDone: "off" }));
      });
      const deskPage = await desk.newPage();
      deskPage.on("pageerror", (error) => errors.push(error.message));
      await deskPage.goto(`${origin}/?pane=${encodeURIComponent(openPane)}`);
      await deskPage.locator(".conn-live").waitFor();
      const seenHere = (pane: string, status: string) => deskPage.locator(`.pane-item:has(.pane-select[title^="${pane} —"]) [data-status="${status}"]`).first().waitFor({ state: "attached" });
      await report(otherPane, "idle");
      await deskPage.bringToFront();
      await report(otherPane, "working"); await seenHere(otherPane, "working"); await report(otherPane, "blocked");
      const toast = deskPage.locator(".alert-toast[data-shown]");
      await toast.waitFor();
      assert.equal(await deskPage.locator(".droplet").count(), 0, "no drop with a mouse");
      const at = (await toast.boundingBox())!;
      assert.ok(at.x + at.width > 1280 - 40 && at.y + at.height > 800 - 60, `toast at ${JSON.stringify(at)}`);
      await toast.click({ position: { x: 40, y: at.height / 2 } });
      await deskPage.locator(`.pane-select[title^="${otherPane} —"][aria-current="true"]`).waitFor({ state: "attached" });
      await deskPage.locator(".alert-toast").waitFor({ state: "detached" });
      console.log("PASS with a mouse the alert is a toast in the corner, and a click opens its pane");
    } finally {
      await desk.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

