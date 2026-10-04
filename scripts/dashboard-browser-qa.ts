/** Isolated browser QA of the built React dashboard; no production API, socket, or user pane. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { chromium } from "playwright-core";

const fixture = resolve(process.env.HERDR_DASHBOARD_FIXTURE ?? "/tmp/herdr-faithful-ux");
const output = "/tmp/herdr-dashboard-implemented";
const visualOutput = "/tmp/herdr-dashboard-visual-correction";
const approvedReference = ["/tmp/herdr-dashboard-ux/sidebar-desktop-dashboard.png", "/tmp/herdr-dashboard-ux/sidebar-mobile-dashboard.png"];
const dist = resolve("dist");
const machines = JSON.parse(readFileSync(join(fixture, "machines.json"), "utf8"));
const source = readFileSync(join(fixture, "transport.js"), "utf8")
  .replaceAll('"sample@example.invalid"', '"Account 1"')
  .replaceAll('"sample-work@example.invalid"', '"Account 2"')
  .replaceAll('"sam@example.com"', '"Account 3"');
assert.equal(machines.machines[0].snapshot.panes.length, 11, "fictional fixture must contain eleven panes");
assert.ok(source.includes('window.WebSocket =') && source.includes('window.fetch ='), "fictional API/socket transport required");
mkdirSync(output, { recursive: true });
mkdirSync(visualOutput, { recursive: true });
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
let passed = false;
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
    second.restore_error = "Could not restore second pane";
    local.snapshot.panes.push(second);
    local.snapshot.workspaces[0].pane_count = 2;
    const offline = structuredClone(local);
    offline.id = "fictional-offline";
    offline.name = "Offline sample PC";
    offline.kind = "ssh";
    offline.state = "disconnected";
    offline.snapshot = structuredClone(local.snapshot);
    machines.push(offline);
    const emptyLocal = structuredClone(local);
    emptyLocal.id = "empty-local";
    emptyLocal.name = "Empty local PC";
    emptyLocal.snapshot = { ...structuredClone(local.snapshot), workspaces: [], panes: [], focused_workspace_id: null, focused_pane_id: null };
    machines.push(emptyLocal);
    const emptyRemote = structuredClone(emptyLocal);
    emptyRemote.id = "empty-remote";
    emptyRemote.name = "Empty remote PC";
    emptyRemote.kind = "ssh";
    machines.push(emptyRemote);
    panes[1].restore_error = "Could not restore single pane";
    offline.snapshot.panes[0].restore_error = "Cached restore error";
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
  if (process.env.DASHBOARD_REPRO !== "usage" && process.env.DASHBOARD_REPRO !== "restore") await act("check per-PC new session actions including empty local and remote", async () => {
    await page.evaluate(() => sessionStorage.setItem("herdr-web-ui:selection", JSON.stringify({ machine_id: "empty-remote", pane_id: null })));
    await page.reload();
    await page.locator(".dashboard-list").waitFor();
    assert.equal(await page.locator(".sidebar-new-session").getAttribute("title"), "New session on Empty remote PC");
    for (const [name, id] of [["Empty local PC", "empty-local"], ["Empty remote PC", "empty-remote"]] as const) {
      const group = page.locator(`.dashboard-machine[aria-label="PC ${name}"]`);
      assert.equal(await group.locator(".dashboard-card").count(), 0);
      await group.getByRole("button", { name: `New session on ${name}` }).click();
      const dialog = page.getByRole("dialog", { name: /New session/ });
      await dialog.waitFor();
      assert.match(await dialog.innerText(), new RegExp(name));
      await dialog.getByRole("button", { name: /Cancel|Close/ }).first().click();
      results[`new-${id}`] = name;
    }
    const offlineGroup = page.locator('.dashboard-machine[aria-label="PC Offline sample PC"]');
    assert.equal(await offlineGroup.getByRole("button", { name: "New session on Offline sample PC" }).isDisabled(), true);
    await page.evaluate((selection) => sessionStorage.setItem("herdr-web-ui:selection", selection!), selectedBefore);
    await page.reload();
    await page.locator(".dashboard-list").waitFor();
  });
  if (process.env.DASHBOARD_REPRO !== "machine" && process.env.DASHBOARD_REPRO !== "restore") await act("hide one account in Settings without hiding another provider", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const visibility = page.getByRole("switch", { name: "Show Codex · Account 2" });
    await visibility.waitFor();
    await visibility.click();
    assert.equal(await visibility.getAttribute("aria-checked"), "false");
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.locator(".dashboard-usage-toggle").click();
    assert.equal(await page.locator(".dashboard-usage-details").getByText("Account 2").count(), 0);
    assert.ok(await page.locator(".dashboard-usage-details").getByText("Account 1").count() > 0);
    await page.locator(".dashboard-usage-toggle").click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const switches = page.locator(".usage-accounts-visibility");
    const names = await switches.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")!));
    for (const name of names) {
      const toggle = page.getByRole("switch", { name, exact: true });
      if (await toggle.getAttribute("aria-checked") === "true") {
        await toggle.click();
        await page.waitForFunction((label) => document.querySelector(`.usage-accounts-visibility[aria-label="${label}"]`)?.getAttribute("aria-checked") === "false", name);
      }
    }
    assert.equal(await page.locator('.usage-accounts-visibility[aria-checked="true"]').count(), 0, "all account visibility switches must be off");
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.waitForFunction(() => document.querySelector(".dashboard-usage-empty")?.textContent === "All accounts hidden", null, { timeout: 5000 });
    assert.equal(await page.locator(".dashboard-usage-empty").innerText(), "All accounts hidden", JSON.stringify(await page.evaluate(() => ({ settings: localStorage.getItem("herdr-web-ui:settings"), usage: document.querySelector(".dashboard-usage")?.textContent }))));
    assert.equal(await page.locator(".dashboard-usage-account").count(), 0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    for (const name of names) {
      const toggle = page.getByRole("switch", { name, exact: true });
      await toggle.click();
      await page.waitForFunction((label) => document.querySelector(`.usage-accounts-visibility[aria-label="${label}"]`)?.getAttribute("aria-checked") === "true", name);
    }
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.locator(".dashboard-usage-account").first().waitFor();
    results.hiddenUsage = { hiddenProviderExcluded: true, allHiddenMessage: true, accountsRestored: names.length };
  });
  if (process.env.DASHBOARD_REPRO !== "machine" && process.env.DASHBOARD_REPRO !== "usage") await act("show restore errors on single, mixed and offline cards without blocking selection", async () => {
    assert.ok((await cards.first().locator(".dashboard-card-meta").innerText()).includes("NOT RESTORED"));
    await cards.first().locator(".dashboard-card-main").click();
    const errored = cards.first().locator(".dashboard-panes li").nth(1);
    assert.equal(await errored.getByText("NOT RESTORED").getAttribute("title"), "Could not restore second pane");
    await errored.locator("button").click();
    assert.equal(JSON.parse((await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection"))) ?? "{}").pane_id, "w1:p2");
    assert.ok((await cards.nth(1).locator(".dashboard-card-meta").innerText()).includes("NOT RESTORED"));
    const offlineCard = page.locator('.dashboard-machine[aria-label="PC Offline sample PC"] .dashboard-card').first();
    assert.ok((await offlineCard.locator(".dashboard-card-meta").innerText()).includes("Disconnected"));
    await offlineCard.locator(".dashboard-card-main").click();
    assert.equal(await offlineCard.locator(".dashboard-panes li").nth(1).getByText("NOT RESTORED").getAttribute("title"), "Could not restore second pane");
    assert.equal(await offlineCard.locator(".dashboard-panes li").nth(1).locator("button").isDisabled(), true);
    await cards.first().locator(".dashboard-panes li").first().locator("button").click();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection")), selectedBefore);
    results.restoreErrors = true;
  });
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
      assert.ok(geometry.cards[0].bottom <= geometry.projects.bottom + 1, `${name}: first project accessible in stress variant`);
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
  await act("capture isolated Korean visual fixture in real React App", async () => {
    const visualContext = await browser!.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: "dark", serviceWorkers: "block" });
    try {
      await visualContext.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || url.pathname.startsWith("/api/") || url.pathname === "/ws") {
          errors.push(`Blocked visual network request: ${url.href}`);
          return route.abort();
        }
        return route.continue();
      });
      await visualContext.addInitScript({ content: `${source}\n(() => {
        machines.splice(1);
        const snapshot = machines[0].snapshot;
        machines[0].name = "Sample PC";
        const names = ["웹사이트", "문서 정리", "이미지 작업", "가계부", "실험실", "보고서", "디자인", "자료실", "작업실", "보관함", "도움말"];
        const agents = ["claude", "codex", "gjc", "claude", "codex", "gjc", "claude", "codex", "gjc", "claude", "codex"];
        snapshot.workspaces.forEach((workspace, index) => { workspace.label = names[index]; });
        snapshot.panes.forEach((pane, index) => {
          pane.agent = agents[index];
          pane.agent_status = index === 1 ? "blocked" : [0, 4, 5].includes(index) ? "working" : [2, 8, 10].includes(index) ? "done" : "idle";
          pane.attention = index === 2 ? { finished_at: new Date(Date.now() - 60000).toISOString(), seen_at: null, preview: "화면 점검 완료 · 읽지 않음" } : null;
          pane.restore_error = null;
        });
        snapshot.panes[1].attention = { finished_at: null, seen_at: null, preview: "수정 방향 선택" };
        snapshot.workspaces.forEach((workspace, index) => { workspace.agent_status = snapshot.panes[index].agent_status; });
        usageReport = () => { const checked = new Date().toISOString(); return { providers: [
          { id: "claude", key: "claude:visual", account: "Account 1", plan: "max", problem: null, checked_at: checked, windows: [{ kind: "week", scope: null, used_percent: 61, resets_at: new Date(Date.now() + 78 * 3600000).toISOString() }] },
          { id: "codex", key: "codex:visual", account: "Account 2", plan: "pro", problem: null, checked_at: checked, windows: [{ kind: "week", scope: null, used_percent: 31, resets_at: new Date(Date.now() + 140 * 3600000).toISOString() }] }
        ] }; };
      })();` });
      await visualContext.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "ko", dashboardSidebar: true })));
      const visualPage = await visualContext.newPage();
      visualPage.on("pageerror", (error) => errors.push(error.message));
      for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 393, 852]] as const) {
        await visualPage.setViewportSize({ width, height });
        await visualPage.goto(`${origin}/?pane=w1:p1`);
        await visualPage.locator(".dashboard-card").first().waitFor({ state: "attached" });
        await visualPage.evaluate(() => document.fonts.ready);
        if (name === "mobile") {
          await visualPage.addStyleTag({ content: ".app-header{height:calc(var(--header-h) + 59px);padding-top:59px}.sidebar{top:calc(var(--header-h) + 59px);padding-bottom:34px}.scrim{top:calc(var(--header-h) + 59px)}.composer{padding-bottom:max(var(--space-4), calc(34px - var(--space-4)))}" });
          const openDrawer = visualPage.locator('.drawer-toggle[aria-expanded="false"]');
          if (await openDrawer.count()) await openDrawer.click();
          await visualPage.waitForFunction(() => document.querySelector(".sidebar")!.getBoundingClientRect().left >= -1);
        }
        await visualPage.locator(".dashboard-usage-account").first().waitFor();
        const facts = await visualPage.evaluate(() => {
          const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON();
          const cards = [...document.querySelectorAll(".dashboard-card")].map((node) => node.getBoundingClientRect().toJSON());
          const labels = [...document.querySelectorAll(".dashboard-attention section")].map((node) => node.querySelector("h3")?.textContent?.trim() ?? "");
          return { sidebar: rect(".sidebar"), usage: rect(".dashboard-usage"), attention: rect(".dashboard-attention"), projects: rect(".dashboard-projects"), footer: rect(".sidebar-footer"), cards, labels, attentionRowChildren: [...document.querySelector('.dashboard-attention li button')!.children].map((node) => ({ tag: node.tagName, rect: node.getBoundingClientRect().toJSON() })), scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, text: document.querySelector(".dashboard-list")!.textContent };
        });
        results[`visual-${name}`] = { ...facts, text: undefined, approvedReference: approvedReference[name === "mobile" ? 1 : 0], mismatchFacts: ["Synthetic unread result belongs to 이미지 작업 rather than the selected 웹사이트 to avoid read-on-open clearing", "Synthetic fixture retains the real App header and chat content; only sidebar geometry/content is compared"] };
        assert.equal(await visualPage.locator(".dashboard-machine").count(), 1, `${name}: one PC`);
        assert.equal(await visualPage.locator(".dashboard-usage-account").count(), 2, `${name}: two providers`);
        assert.equal(facts.cards.length, 11, `${name}: eleven named projects`);
        for (const label of ["응답 필요", "새 결과", "작업 중"]) assert.ok(facts.labels.some((text) => text.includes(label)), `${name}: missing ${label}`);
        for (const [label, expected] of [["응답 필요", "1"], ["새 결과", "1"], ["작업 중", "3"]] as const) {
          const section = visualPage.locator(".dashboard-attention section").filter({ has: visualPage.locator("h3", { hasText: label }) });
          assert.equal(await section.count(), 1, `${name}: ${label} section`);
          assert.equal(await section.locator(".pill").first().innerText(), expected, `${name}: ${label} count`);
        }
        assert.equal(await visualPage.locator(".dashboard-attention section").nth(0).locator("li").count(), 1, `${name}: visible needs-input row`);
        assert.equal(await visualPage.locator(".dashboard-attention section").nth(1).locator("li").count(), 1, `${name}: visible unread row`);
        assert.ok(facts.text?.includes("문서 정리") && facts.text.includes("웹사이트"), `${name}: named attention items`);
        assert.ok(facts.scrollWidth <= width + 1, `${name}: horizontal overflow`);
        assert.ok(facts.usage.top >= facts.sidebar.top - 1 && facts.usage.bottom <= facts.attention.top + 1 && facts.attention.bottom <= facts.projects.top + 1, `${name}: section bounds`);
        assert.ok(facts.projects.top < facts.footer.top && facts.footer.bottom <= height + 1, `${name}: projects/footer bounds`);
        assert.ok(facts.usage.height >= 45 && facts.attention.height >= 85 && facts.projects.height >= 110, `${name}: sensible section heights`);
        assert.ok(facts.cards.slice(0, 4).every((card) => card.height >= 40 && card.height <= 120 && card.top >= facts.projects.top && card.bottom <= facts.footer.top + 1), `${name}: four full, sensibly sized cards`);
        await visualPage.screenshot({ path: join(visualOutput, `${name}.png`) });
      }
    } finally { await visualContext.close(); }
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
  passed = true;
  console.log(`PASS dashboard browser QA: ${join(output, "receipt.json")}`);
} finally {
  writeFileSync(join(output, "receipt.json"), JSON.stringify({ commands, results, errors, fixture, origin, screenshots: [join(output, "desktop.png"), join(output, "mobile.png")], visualScreenshots: [join(visualOutput, "desktop.png"), join(visualOutput, "mobile.png")], approvedReference, comparison: "Visual fixture uses real React App and synthetic transport; screenshots require visual review against approved references, not pixel equality." }, null, 2));
  writeFileSync(join(visualOutput, "receipt.json"), JSON.stringify({ passed, approvedReference, actual: [join(visualOutput, "desktop.png"), join(visualOutput, "mobile.png")], visual: { desktop: results["visual-desktop"], mobile: results["visual-mobile"] }, mismatches: ["Selected 웹사이트 cannot remain unread in the real App: selecting it marks the result seen. Fixture uses unread 이미지 작업 instead.", "App header/chat and localized Settings/footer are real React output rather than the approved DOM prototype; their content is not compared.", "Usage top starts 5px above prototype and occupies roughly 6px more, while the project section starts at approximately the approved 480px."], fixes: ["One compact primary visible account per provider, all accounts and windows in Details, no aggregated quota.", "Attention categories stay visible by default, with one row each and expandable remainder.", "Card title and agent name/status occupy two fixed rows; single-PC caption and + share the project heading."], checks: commands, errors }, null, 2));
  await browser?.close();
  server.stop();
}
