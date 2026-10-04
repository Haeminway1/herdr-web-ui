/** Isolated browser QA of the built React dashboard; no production API, socket, or user pane. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { chromium } from "playwright-core";

const fixture = resolve(process.env.HERDR_DASHBOARD_FIXTURE ?? "/tmp/herdr-faithful-ux");
const output = "/tmp/herdr-dashboard-implemented";
const dist = resolve("dist");
const machines = JSON.parse(readFileSync(join(fixture, "machines.json"), "utf8"));
const source = readFileSync(join(fixture, "transport.js"), "utf8")
  .replaceAll('"sample@example.invalid"', '"Account 1"')
  .replaceAll('"sample-work@example.invalid"', '"Account 2"')
  .replaceAll('"sam@example.com"', '"Account 3"');
assert.equal(machines.machines[0].snapshot.panes.length, 11, "fictional fixture must contain eleven panes");
assert.ok(source.includes('window.WebSocket =') && source.includes('window.fetch ='), "fictional API/socket transport required");
mkdirSync(output, { recursive: true });
const commands: string[] = [];
const results: Record<string, unknown> = {};
const errors: string[] = [];
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (path.startsWith("/api/") || path === "/ws") return new Response("Live API forbidden", { status: 503 });
  const file = Bun.file(join(dist, path === "/" ? "index.html" : path));
  return file.exists().then((exists) => exists ? new Response(file, { headers: { "Content-Type": path === "/" ? "text/html" : mime[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store" } }) : new Response("Not found", { status: 404 }));
} });
const origin = `http://127.0.0.1:${server.port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith("/api/") || url.pathname === "/ws") {
      errors.push(`Blocked network request: ${url.href}`);
      return route.abort();
    }
    return route.continue();
  });
  // The fictional transport is a prebuilt demo: it intercepts the real App's fetch, SSE, and WS.
  // Extend its own in-memory machines before React mounts, never alter rendered DOM or app sources.
  await context.addInitScript({ content: `${source}\n(() => {
    const local = machines[0];
    const panes = local.snapshot.panes;

    panes[2].agent_status = "done";
    panes[2].attention = { finished_at: new Date(Date.now() - 60000).toISOString(), seen_at: null, preview: "Finished illustration" };
    const second = structuredClone(panes[0]);
    second.pane_id = "w1:p2";
    second.terminal_id = "w1:term2";
    second.label = "Second pane";
    second.title = "Second pane";
    second.agent_status = "idle";
    local.snapshot.panes.push(second);
    local.snapshot.workspaces[0].pane_count = 2;
    const offline = structuredClone(local);
    offline.id = "fictional-offline";
    offline.name = "Offline sample PC";
    offline.kind = "ssh";
    offline.state = "disconnected";
    offline.snapshot = structuredClone(local.snapshot);
    machines.push(offline);
  })();\n` });
  await context.addInitScript(() => {
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", dashboardSidebar: false }));
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const act = async (label: string, action: () => Promise<unknown>) => { commands.push(label); await action(); };
  await act("open real React App with fictional transport", () => page.goto(origin));
  await page.locator(".machine-list").waitFor();
  assert.equal(await page.locator(".dashboard-list").count(), 0, "dashboard is opt-in");
  const selectedBefore = await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection"));
  await act("open Settings and enable Project dashboard sidebar", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "Project dashboard sidebar" });
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await page.getByRole("button", { name: "Close settings" }).click();
  });
  await page.locator(".dashboard-list").waitFor();
  const cards = page.locator(".dashboard-machine").first().locator(".dashboard-card");
  assert.equal(await cards.count(), 11, "one project card per original workspace, not per pane");
  assert.equal(await page.locator(".dashboard-machine").nth(1).locator(".dashboard-card").count(), 11, "offline cached projects remain visible");
  assert.ok((await page.locator(".dashboard-list").innerText()).includes("Sample PC"));
  assert.ok((await page.locator(".dashboard-list").innerText()).includes("Offline sample PC"));
  await page.locator('.dashboard-usage-bar[aria-valuenow="84"]').first().waitFor();
  results.usage = { usedPercent: Number(await page.locator('.dashboard-usage-bar[aria-valuenow="84"]').first().getAttribute("aria-valuenow")), source: "fictional transport /api/usage" };
  assert.equal(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection")), selectedBefore, "switch must not change selected pane");
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}"));
  assert.equal(settings.dashboardSidebar, true);
  results.initial = { cards: await cards.count(), selectedBefore, settings: settings.dashboardSidebar };
  await act("reload with persisted dashboard preference", () => page.reload());
  await page.locator(".dashboard-list").waitFor();
  assert.equal(await page.locator(".dashboard-machine").first().locator(".dashboard-card").count(), 11);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection")), selectedBefore);
  await act("open second pane from multi-pane project card", async () => {
    await cards.first().locator(".dashboard-card-main").click();
    await cards.first().locator(".dashboard-panes li:nth-child(2) > button").first().click();
    assert.equal(JSON.parse((await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection"))) ?? "{}").pane_id, "w1:p2");
  });
  await act("rename affordance does not close a pane", async () => {
    const before = await cards.count();
    const menu = cards.nth(1).locator(".dashboard-card-menu");
    await menu.locator("summary").click();
    await cards.nth(1).getByRole("button", { name: /Rename workspace/ }).click();
    await cards.nth(1).getByRole("textbox", { name: "Workspace name" }).press("Escape");
    if (await menu.getAttribute("open") !== null) await menu.locator("summary").click();
    assert.equal(await cards.count(), before);
  });
  if (await cards.first().locator(".dashboard-card-main").getAttribute("aria-expanded") === "true") await cards.first().locator(".dashboard-card-main").click();
  await page.locator(".dashboard-attention").evaluate((element) => { element.scrollTop = 0; });
  for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 393, 852]] as const) {
    await act(`capture ${name} ${width}x${height}`, async () => {
      await page.setViewportSize({ width, height });
      if (name === "mobile") {
        await page.addStyleTag({ content: ".app-header{height:calc(var(--header-h) + 59px);padding-top:59px}.sidebar{top:calc(var(--header-h) + 59px);padding-bottom:34px}.scrim{top:calc(var(--header-h) + 59px)}" });
        const drawer = page.locator(".sidebar-shell");
        await page.getByRole("button", { name: "Open workspace list" }).click();
        await drawer.waitFor({ state: "visible" });
        await page.waitForFunction(() => document.querySelector(".sidebar")!.getBoundingClientRect().left >= -1);
      }
      await page.waitForTimeout(350);
      const geometry = await page.evaluate(() => {
        const root = document.documentElement;
        const sidebar = document.querySelector(".dashboard-list")!;
        const cards = [...document.querySelectorAll(".dashboard-machine:first-child .dashboard-card")];
        const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
        return { scrollWidth: root.scrollWidth, viewportWidth: innerWidth, sidebar: rect(sidebar), usage: rect(document.querySelector(".dashboard-usage")!), attention: rect(document.querySelector(".dashboard-attention")!), projects: rect(document.querySelector(".dashboard-projects")!), cards: cards.map(rect), footer: rect(document.querySelector(".sidebar-footer")!), cardCount: cards.length };
      });
      results[name] = geometry;
      assert.ok(geometry.scrollWidth <= width + 1, `${name} horizontal overflow: ${geometry.scrollWidth}`);
      assert.equal(geometry.cardCount, 11);
      assert.ok(geometry.cards[3].bottom <= geometry.projects.bottom + 1, `${name}: two complete rows visible in project scroll region`);
      assert.ok(geometry.usage.bottom <= geometry.attention.y + 1 && geometry.attention.bottom <= geometry.projects.y + 1, `${name}: usage and summary remain visible above cards`);
      assert.ok(geometry.footer.width > 0 && geometry.footer.height > 0, `${name}: footer accessible`);
      await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await act("navigate attention input, unread, and working", async () => {
    for (const [section, pane] of [["Needs you", "w4:p1"], ["To read", "w3:p1"], ["Working", "w1:p1"]] as const) {
      const group = page.locator(".dashboard-attention").getByRole("region", { name: section });
      if (section === "Working") await group.getByRole("button", { name: /Working/ }).click();
      await group.locator("li button").first().click();
      const selected = JSON.parse((await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection"))) ?? "{}");
      assert.equal(selected.pane_id, pane, `${section} opens exact pane`);
    }
  });
  await act("check enlarged text at 320px", async () => {
    await page.setViewportSize({ width: 320, height: 852 });
    await page.addStyleTag({ content: ".is-dashboard { --fs-xs: 24px; --fs-sm: 26px; --fs-md: 28px; --fs-lg: 32px; }" });
    const size = await page.evaluate(() => { const sidebar = document.querySelector(".sidebar")!.getBoundingClientRect(); const grid = document.querySelector(".dashboard-grid")!.getBoundingClientRect(); return { sidebar: sidebar.toJSON(), grid: grid.toJSON(), scroll: document.documentElement.scrollWidth, viewport: innerWidth }; });
    assert.ok(size.scroll <= size.viewport + 1 && size.grid.right <= size.sidebar.right + 1, `enlarged dashboard text overflows horizontally: ${JSON.stringify(size)}`);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await act("turn dashboard off without changing the current pane", async () => {
    const before = await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection"));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "Project dashboard sidebar" });
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.locator(".machine-list").waitFor();
    assert.equal(await page.locator(".dashboard-list, .dashboard-usage").count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection")), before);
    await page.reload();
    await page.locator(".machine-list").waitFor();
    assert.equal(await page.locator(".dashboard-list").count(), 0);
  });
  assert.deepEqual(errors, [], "no browser exceptions or external/live requests");
  console.log(`PASS dashboard browser QA: ${join(output, "receipt.json")}`);
} finally {
  writeFileSync(join(output, "receipt.json"), JSON.stringify({ commands, results, errors, fixture, origin, screenshots: [join(output, "desktop.png"), join(output, "mobile.png")], approvedReference: [join(fixture, "sidebar-desktop-compare.png"), join(fixture, "sidebar-mobile-compare.png")] }, null, 2));
  await browser?.close();
  server.stop();
}
