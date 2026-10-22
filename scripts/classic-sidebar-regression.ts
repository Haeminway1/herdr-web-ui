import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { chromePath } from "./chrome-path.ts";
import { createClassicSidebarDemo } from "./classic-sidebar-preview.ts";

interface Surface {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly phone: boolean;
  readonly theme: "dark" | "light";
}

const surfaces: readonly Surface[] = [
  { name: "desktop-dark", width: 1280, height: 800, phone: false, theme: "dark" },
  { name: "desktop-light", width: 1280, height: 800, phone: false, theme: "light" },
  { name: "phone-dark", width: 390, height: 844, phone: true, theme: "dark" },
  { name: "phone-light", width: 390, height: 844, phone: true, theme: "light" },
];

async function openSurface(browser: Browser, demoUrl: string, surface: Surface): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: surface.width, height: surface.height },
    isMobile: surface.phone,
    hasTouch: surface.phone,
    locale: "en-US",
  });
  await context.addInitScript(({ theme, paneId }) => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({
      language: "en",
      theme,
      sidebarLayout: "classic",
      sidebarGrouping: "repo",
      palette: "report",
      paletteDark: "report",
      paletteLight: "report",
      darkTheme: "report",
      lightTheme: "report",
    }));
    localStorage.setItem("herdr-web-ui:resident-tab", "work");
    localStorage.setItem("herdr-web-ui:pc-collapsed:local", "0");
    sessionStorage.setItem("herdr-web-ui:selection", JSON.stringify({ machine_id: "local", pane_id: paneId }));
  }, { theme: surface.theme, paneId: panes.infra });
  const page = await context.newPage();
  await page.goto(`${demoUrl}?pane=${encodeURIComponent(panes.infra)}&view=chat`);
  if (surface.phone) await page.getByRole("button", { name: "Open workspace list" }).click();
  await page.locator(".machine-workspaces > .cl-sidebar-list").waitFor();
  await page.locator('.cl-sidebar-list .cl-pane-select[title*="Classic preview workspace 36"]').waitFor();
  await page.waitForFunction(theme => document.documentElement.dataset["theme"] === theme && document.documentElement.dataset["palette"] === "report", surface.theme);
  await page.waitForFunction(() => Number(document.documentElement.dataset["classicPreviewStreamSnapshots"]) > 0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.locator('.cl-sidebar-list .cl-pane-select[title*="Classic preview workspace 36"]').count(), 1, "live fixture streams must not erase the overflowing roster");
  return context;
}

async function verifyScrollOwners(page: Page, theme: Surface["theme"]): Promise<void> {
  const measurements = await page.evaluate(() => {
    const outer = document.querySelector<HTMLElement>(".machine-list");
    const inner = document.querySelector<HTMLElement>(".machine-workspaces > .cl-sidebar-list");
    if (!outer || !inner) throw new Error("classic sidebar scroll regions are missing");
    return { outerClientHeight: outer.clientHeight, outerScrollHeight: outer.scrollHeight, innerScrollTop: inner.scrollTop };
  });
  assert.ok(measurements.outerScrollHeight > measurements.outerClientHeight, "the outer machine list must have natural overflow");
  assert.equal(measurements.innerScrollTop, 0);

  const row = page.locator(".machine-workspaces > .cl-sidebar-list .cl-pane-select").first();
  await row.scrollIntoViewIfNeeded();
  const bounds = await row.boundingBox();
  assert.ok(bounds, "a classic pane row must be visible for the wheel test");
  const before = await page.locator(".machine-list").evaluate(element => element.scrollTop);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 160);
  await page.waitForFunction(previous => {
    const outer = document.querySelector<HTMLElement>(".machine-list");
    return outer !== null && outer.scrollTop > previous;
  }, before);
  const after = await page.locator(".machine-list").evaluate(element => element.scrollTop);
  const innerScrollTop = await page.locator(".machine-workspaces > .cl-sidebar-list").evaluate(element => element.scrollTop);
  assert.ok(after > before, "a wheel over a classic pane row must move the outer machine list");
  assert.equal(innerScrollTop, 0, "the embedded classic roster must not capture the wheel");

  const footer = page.locator(".sidebar-footer");
  assert.equal(await footer.isVisible(), true, "the sidebar footer must remain usable");
  const footerBefore = await footer.boundingBox();
  assert.ok(footerBefore);
  const settingsButton = footer.getByRole("button", { name: "Settings" });
  await settingsButton.click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.waitFor();
  await dialog.getByRole("tab", { name: "Appearance" }).click();
  const themeControl = dialog.getByRole("group", { name: "Theme" });
  const currentTheme = theme === "dark" ? "Dark" : "Light";
  const alternateTheme = theme === "dark" ? "Light" : "Dark";
  assert.equal(await dialog.locator("#settings-theme-dark").inputValue(), "report");
  assert.equal(await dialog.locator("#settings-theme-light").inputValue(), "report");
  await themeControl.getByRole("button", { name: alternateTheme, exact: true }).click();
  await page.waitForFunction(value => document.documentElement.dataset["theme"] === value, alternateTheme.toLowerCase());
  await themeControl.getByRole("button", { name: currentTheme, exact: true }).click();
  await page.waitForFunction(value => document.documentElement.dataset["theme"] === value, theme);
  await page.getByRole("button", { name: "Close settings" }).click();
  await dialog.waitFor({ state: "detached" });
  if (await page.locator('button[aria-controls="workspace-drawer"]').isVisible()) {
    await page.locator('button[aria-controls="workspace-drawer"]').click();
    await page.locator("#workspace-drawer.is-open").waitFor();
  }
  const footerAfter = await footer.boundingBox();
  assert.ok(footerAfter);
  assert.equal(Math.round(footerAfter.y), Math.round(footerBefore.y), "the footer must stay fixed while the machine list scrolls");
}

async function verifyClassicFeatures(page: Page): Promise<void> {
  const inbox = page.locator('.needs-input[aria-label="Working"]');
  assert.equal(await inbox.count(), 1, "the existing attention inbox must remain visible");
  assert.equal(await page.locator(".cl-system-resident-top .cl-pane-item.is-system").count(), 1, "the pinned Manager row must remain visible");
  const residentTabs = page.locator(".cl-resident-tabs button");
  assert.equal(await residentTabs.count(), 2, "Resident and Work tabs must remain available");
  await residentTabs.filter({ hasText: "Resident" }).click();
  await page.getByText("Resident preview", { exact: true }).first().waitFor();
  await residentTabs.filter({ hasText: "Work" }).click();
  const workRows = page.locator(".cl-resident-tab .cl-pane-select");
  assert.ok(await workRows.count() >= 36, "the work tab must preserve repo-grouped workspace rows");
  const stored = await page.evaluate(() => {
    const settings = localStorage.getItem("herdr-web-ui:settings") ?? "{}";
    return settings.includes('"sidebarLayout":"classic"') && settings.includes('"sidebarGrouping":"repo"');
  });
  assert.equal(stored, true);
}

async function verifyStandaloneScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    const source = document.querySelector<HTMLElement>(".machine-workspaces > .cl-sidebar-list");
    if (!source) throw new Error("embedded classic list is missing");
    const shell = document.createElement("aside");
    shell.className = "cl-sidebar-shell";
    shell.style.cssText = "position:fixed;right:0;top:80px;width:300px;height:360px;z-index:2147483647;opacity:.01;pointer-events:auto";
    const topbar = document.createElement("div");
    topbar.className = "cl-sidebar-topbar";
    const list = source.cloneNode(true);
    const footer = document.createElement("footer");
    footer.className = "cl-sidebar-footer";
    shell.append(topbar, list, footer);
    document.body.append(shell);
  });
  const standaloneList = page.locator(".cl-sidebar-shell > .cl-sidebar-list");
  const row = standaloneList.locator(".cl-pane-select").first();
  await row.scrollIntoViewIfNeeded();
  const bounds = await row.boundingBox();
  assert.ok(bounds, "the standalone list row must be visible for the wheel test");
  const before = await standaloneList.evaluate(element => element.scrollTop);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 180);
  await page.waitForFunction(previous => {
    const list = document.querySelector<HTMLElement>(".cl-sidebar-shell > .cl-sidebar-list");
    return list !== null && list.scrollTop > previous;
  }, before);
  const after = await standaloneList.evaluate(element => element.scrollTop);
  assert.ok(after > before, "the standalone classic sidebar must keep its own scroll");
  await page.locator(".cl-sidebar-shell").evaluate(element => element.remove());
}

async function verifyPaneSelection(page: Page): Promise<void> {
  const row = page.locator(".cl-resident-tab .cl-pane-select").filter({ hasText: "Classic preview workspace 36" });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await page.waitForFunction(() => document.querySelector('.cl-sidebar-list .cl-pane-select[aria-current="true"]')?.textContent?.includes("Classic preview workspace 36") === true);
  assert.equal(await row.getAttribute("aria-current"), "true", "selecting a workspace must update the current pane");
}

interface SurfaceRun {
  readonly browser: Browser;
  readonly demoUrl: string;
  readonly surface: Surface;
  readonly artifacts: string;
}

async function verifySurface({ browser, demoUrl, surface, artifacts }: SurfaceRun): Promise<void> {
  const context = await openSurface(browser, demoUrl, surface);
  try {
    const page = context.pages()[0];
    assert.ok(page);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await verifyClassicFeatures(page);
    await verifyScrollOwners(page, surface.theme);
    await verifyStandaloneScroll(page);
    await page.screenshot({ path: join(artifacts, `${surface.name}.png`) });
    await verifyPaneSelection(page);
    assert.deepEqual(errors, [], "the fixture UI must not emit page errors");
    console.log(`PASS ${surface.name}: outer wheel, footer, Manager, inbox, Resident/Work, selection surface, standalone scroll`);
  } finally {
    await context.close();
  }
}

const artifacts = join(import.meta.dir, "../_artifacts/classic-sidebar");
mkdirSync(artifacts, { recursive: true });
const demo = await createClassicSidebarDemo({ hostname: "127.0.0.1", port: 0 });
try {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    for (const surface of surfaces) await verifySurface({ browser, demoUrl: demo.url, surface, artifacts });
  } finally {
    await browser.close();
  }
} finally {
  demo.close();
}
console.log(`PASS 4 surfaces: screenshots saved to ${artifacts}`);
