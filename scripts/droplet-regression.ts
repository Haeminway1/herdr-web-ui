import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * In-app alerts on a phone-sized page: real herdr status changes reach the open app, which
 * drops a card for a pane other than the open one (and none for the open one). A tap opens
 * that pane; a flick up puts one away; one left alone goes by itself.
 */
export async function checkDroplet(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-droplet-"));
  const workspaces: string[] = [];
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    const panes: string[] = [];
    for (const suffix of ["open", "other", "third"]) {
      const cwd = join(root, suffix);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-droplet-${suffix}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
    }
    const [openPane, otherPane, thirdPane] = panes as [string, string, string];
    const report = (pane: string, state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
    await report(openPane, "idle");
    await report(otherPane, "idle");
    await report(thirdPane, "idle");

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
    await card.waitFor({ state: "visible" });
    assert.match((await card.getAttribute("aria-label")) ?? "", /Needs input/);
    assert.equal(await droplet.getAttribute("data-kind"), "blocked");
    // the capsule stays below the physical safe area and the app's own header
    await Bun.sleep(1_800); // the springs settle: the drop's fall and the card's spread overshoot first
    const box = (await card.boundingBox())!;
    const headerBottom = await page.locator(".app-header").evaluate((element) => element.getBoundingClientRect().bottom);
    assert.ok(box.y >= headerBottom + 11 && box.y <= headerBottom + 13, `card top ${box.y}, header bottom ${headerBottom}`);
    assert.ok(Math.abs(box.x + box.width / 2 - 196.5) <= 1, `card centre ${box.x + box.width / 2}`);
    assert.ok(box.width <= 393 - 24 && box.width > 300, `card width ${box.width}`);
    // Simulate a safe area taller than the header; the real component reads the probe's CSS inset.
    const safeInset = await page.addStyleTag({ content: ".droplet-probe { padding-top: 120px !important; }" });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForFunction(() => (document.querySelector(".droplet-card")?.getBoundingClientRect().top ?? 0) >= 131);
    assert.ok((await card.boundingBox())!.y >= 132, "the alert stays below the simulated safe inset");
    await safeInset.evaluate((element) => element.remove());
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForFunction((top) => Math.abs((document.querySelector(".droplet-card")?.getBoundingClientRect().top ?? 0) - top) < 1, box.y);
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "droplet-phone.png") });
    await card.tap();
    await droplet.waitFor({ state: "detached" });
    await page.locator(`.pane-select[title^="${otherPane} —"][aria-current="true"]`).waitFor({ state: "attached", timeout: 5_000 });
    assert.equal(await selected(), otherPane, "a tap opens the pane it is about");
    console.log("PASS an in-app alert drops in for another pane, and a tap opens it");

    await page.setViewportSize({ width: 852, height: 393 });
    await report(openPane, "idle");
    await block(openPane);
    await card.waitFor({ state: "visible" });
    await Bun.sleep(700);
    const landscape = (await card.boundingBox())!;
    const landscapeHeader = await page.locator(".app-header").evaluate((element) => element.getBoundingClientRect().bottom);
    assert.ok(landscape.y >= landscapeHeader + 11 && landscape.y <= landscapeHeader + 13, `landscape top ${landscape.y}, header bottom ${landscapeHeader}`);
    assert.ok(Math.abs(landscape.x + landscape.width / 2 - 426) <= 1, `landscape centre ${landscape.x + landscape.width / 2}`);
    assert.ok(landscape.x >= 12 && landscape.x + landscape.width <= 840, `landscape safe bounds ${JSON.stringify(landscape)}`);
    await page.setViewportSize({ width: 393, height: 550 }); // software keyboard-sized visual area
    await Bun.sleep(100);
    const keyboard = (await card.boundingBox())!;
    const keyboardHeader = await page.locator(".app-header").evaluate((element) => element.getBoundingClientRect().bottom);
    assert.ok(keyboard.y >= keyboardHeader + 11 && keyboard.y + keyboard.height < 550, `keyboard-visible bounds ${JSON.stringify(keyboard)}`);
    assert.ok(Math.abs(keyboard.x + keyboard.width / 2 - 196.5) <= 1, `keyboard-visible centre ${keyboard.x + keyboard.width / 2}`);
    await page.setViewportSize({ width: 393, height: 852 });
    console.log("PASS portrait, landscape, and keyboard-sized viewport keep the alert in view");

    // a flick up puts it away, and opens nothing
    await Bun.sleep(700);
    const flick = (await card.boundingBox())!;
    await page.mouse.move(flick.x + flick.width / 2, flick.y + flick.height / 2);
    await page.mouse.down();
    await page.mouse.move(flick.x + flick.width / 2, flick.y + flick.height / 2 - 40, { steps: 4 });
    await page.mouse.up();
    await droplet.waitFor({ state: "detached", timeout: 4_000 }); // the drop folds back up on its springs
    assert.equal(await selected(), otherPane, "a flick up opens nothing");
    console.log("PASS a flick up puts an in-app alert away");

    await report(openPane, "idle");
    await block(openPane);
    await card.waitFor({ state: "visible" });
    const firstLabel = await card.getAttribute("aria-label");
    await block(thirdPane);
    await page.waitForFunction((previous) => {
      const label = document.querySelector(".droplet-card")?.getAttribute("aria-label");
      return label !== null && label !== undefined && label !== previous;
    }, firstLabel, { timeout: 5_000 });
    assert.equal(await card.count(), 1, "only the latest alert remains");
    assert.equal(await selected(), otherPane, "replacement does not open either alert");
    await card.tap();
    await droplet.waitFor({ state: "detached" });
    assert.equal(await selected(), thirdPane, "replacement alert opens its own target");
    console.log("PASS sequential alerts replace one another and open the latest target");

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

    const quiet = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: "en-US", reducedMotion: "reduce" });
    try {
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
      await quietPage.waitForTimeout(65);
      const middle = await geometry();
      await quietPage.waitForTimeout(250);
      const end = await geometry();
      assert.deepEqual(middle, start, "reduced-motion entry has no intermediate geometry change");
      assert.deepEqual(end, start, "reduced-motion entry has no final geometry change");
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

