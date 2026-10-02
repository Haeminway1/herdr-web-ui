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

/**
 * A push that arrives while no window of the app runs still reaches the bell: the service worker
 * writes it down (public/sw.js) and the next page merges it in, once (lib/pushedAlerts.ts).
 */
export async function checkPushedAlertWhileClosed(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await context.grantPermissions(["notifications"], { origin });
    await context.addInitScript(() => {
      if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
    });
    const app = await context.newPage();
    const errors: string[] = [];
    app.on("pageerror", (error) => errors.push(error.message));
    await app.goto(origin);
    await app.locator(".conn-live").waitFor();
    await app.evaluate(async () => { await navigator.serviceWorker.ready; });

    // the worker is driven from a page that is not the app, and the app is closed
    const blank = await context.newPage();
    await blank.goto("about:blank");
    const cdp = await context.newCDPSession(blank);
    const registrations = new Map<string, string>();
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations: list }) => {
      for (const registration of list) if (!registration.isDeleted) registrations.set(registration.scopeURL, registration.registrationId);
    });
    await cdp.send("ServiceWorker.enable");
    await app.close();
    const scope = `${origin}/`;
    for (let i = 0; i < 50 && !registrations.has(scope); i++) await blank.waitForTimeout(100);
    const registrationId = registrations.get(scope);
    assert.ok(registrationId, "the app's service worker is registered");

    const at = Date.now() - 60_000;
    const push = { pane_id: "w9:p9", machine_id: "local", title: "pushed while closed", body: "waiting for your input", tag: "herdr-pane-w9:p9", kind: "blocked", at };
    const deliver = (data: object) => cdp.send("ServiceWorker.deliverPushMessage", { origin, registrationId, data: JSON.stringify(data) });
    await deliver(push);
    await deliver(push); // delivered twice: still one alert in the list
    await deliver({ pane_id: null, title: "herdr", body: "Alerts are on for this device", tag: "herdr-test" }); // a test push is no alert

    // what the worker wrote, read from a page of the origin that is not the app
    const peek = await context.newPage();
    await peek.goto(`${origin}/favicon.png`);
    const stored = (): Promise<number> => peek.evaluate(() => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open("herdr-web-ui-alerts", 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("pushed", { autoIncrement: true }); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const count = db.transaction("pushed").objectStore("pushed").count();
        count.onsuccess = () => { db.close(); resolve(count.result); };
        count.onerror = () => { db.close(); reject(count.error); };
      };
    }));
    for (let i = 0; i < 50 && await stored() < 2; i++) await peek.waitForTimeout(100);
    assert.equal(await stored(), 2, "the worker writes down each alert push, and not the test push");
    await peek.close();

    const reopened = await context.newPage();
    reopened.on("pageerror", (error) => errors.push(error.message));
    await reopened.goto(origin);
    await reopened.locator(".conn-live").waitFor();
    await reopened.locator(".alert-bell-count").waitFor({ timeout: 15_000 });
    await reopened.locator(".alert-bell-button").click();
    const item = reopened.locator(".alert-bell-item", { hasText: "pushed while closed" });
    await item.first().waitFor();
    assert.equal(await item.count(), 1, "a push delivered twice is one alert");
    assert.match(await item.first().getAttribute("class") ?? "", /is-new/);
    assert.match(await item.first().innerText(), /Needs input/);
    assert.equal(await reopened.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:alert-log") ?? "[]").length), 1);
    await reopened.keyboard.press("Escape");
    // taken once: a reload does not add it again
    await reopened.reload();
    await reopened.locator(".conn-live").waitFor();
    assert.equal(await reopened.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:alert-log") ?? "[]").length), 1);
    assert.deepEqual(errors, []);
    console.log("PASS a push heard while the app was closed is in the bell, once");
  } finally {
    await context.close();
  }
}
