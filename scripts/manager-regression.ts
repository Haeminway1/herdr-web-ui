/** Browser regression for the optional local manager, using only the fictional site demo transport.
 * Run after `bun run build`: `bun scripts/manager-regression.ts`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const dist = resolve(import.meta.dir, "../dist");
assert.ok(existsSync(join(dist, "index.html")), "Build the client first: bun run build");
const bundled = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../site/demo/transport.ts")],
  target: "browser",
  define: { __APP_VERSION__: JSON.stringify("demo-regression") },
});
assert.ok(bundled.success, `Demo transport bundle failed: ${bundled.logs.map(String).join("\n")}`);
const transport = await bundled.outputs[0]!.text();
const html = (await Bun.file(join(dist, "index.html")).text()).replace(
  /<script type="module"/,
  '<script src="/demo-transport.js"></script><script type="module"',
);
assert.ok(html.includes('src="/demo-transport.js"'), "Built client has no module entrypoint");
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/demo-transport.js") return new Response(transport, { headers: { "content-type": "text/javascript" } });
    const relative = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
    if (relative.split("/").includes("..")) return new Response("bad path", { status: 400 });
    const file = Bun.file(join(dist, relative));
    return await file.exists() ? new Response(path === "/" ? html : file, {
      headers: path === "/" ? { "content-type": "text/html" } : undefined,
    }) : new Response("not found", { status: 404 });
  },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 800 } });
  const origin = `http://127.0.0.1:${server.port}`;
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  const managerButton = page.getByRole("button", { name: "Local manager" });
  await managerButton.waitFor();
  const dialog = page.getByRole("dialog", { name: "Manager" });
  const openDialog = async () => { await managerButton.click(); await dialog.getByText("Manager status: absent").or(dialog.getByText("Manager status: running")).or(dialog.getByText("Manager status: stopped")).waitFor(); };
  await openDialog();
  await dialog.getByText("Manager status: absent").waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Start manager" }).isDisabled(), true, "agent must be selected explicitly");
  await dialog.getByRole("combobox", { name: "Agent" }).selectOption("codex");
  await dialog.getByRole("button", { name: "Start manager" }).click();
  await dialog.waitFor({ state: "hidden" });
  const identity = await page.evaluate(() => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "null") as { machine_id: string; pane_id: string });
  assert.equal(identity.machine_id, "local", "manager selects the local PC, not a remote target");
  assert.match(identity.pane_id, /^w[0-9a-z]+:p1$/, "manager's new pane is selected");
  await page.locator(".context").filter({ hasText: "Herdr Manager" }).waitFor();

  // Stage a second fictional PC through the same demo machine roster, then navigate
  // from its pane to the verified local manager (never to a remote pane with the same ID).
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname !== "/api/machines") return original(input, init);
      return original(input, init).then(async (response) => {
        const data = await response.json() as { machines: Array<Record<string, unknown>> };
        data.machines.push({ ...structuredClone(data.machines[0]), id: "fictional-remote", name: "fictional-remote", kind: "ssh" });
        return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
      });
    }) as typeof fetch;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const remote = page.getByRole("region", { name: "PC fictional-remote" });
  await remote.locator(".pane-select").first().click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "null")?.machine_id === "fictional-remote");
  const remoteSelection = await page.evaluate(() => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "null"));
  await openDialog();
  await dialog.getByText("Manager status: running").waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Start manager" }).count(), 0, "running manager is reused rather than started twice");
  assert.equal(await dialog.getByRole("button", { name: "Open manager" }).isEnabled(), true);

  // Change the GET response after the dialog loaded: Open must reject stale identity.
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname === "/api/manager") {
        return Promise.resolve(new Response(JSON.stringify({ state: "running", workspace_id: "stale", pane_id: "stale:p1" }), { headers: { "content-type": "application/json" } }));
      }
      return original(input, init);
    }) as typeof fetch;
    (window as typeof window & { restoreManagerFetch?: () => void }).restoreManagerFetch = () => { window.fetch = original; };
  });
  await dialog.getByRole("button", { name: "Open manager" }).click();
  await dialog.getByRole("alert").getByText(/Manager identity changed/).waitFor();
  assert.equal(await dialog.isVisible(), true, "stale response must not navigate");
  assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "null")), remoteSelection);
  await page.evaluate(() => (window as typeof window & { restoreManagerFetch: () => void }).restoreManagerFetch());
  await dialog.getByRole("button", { name: "Refresh" }).click();
  await dialog.getByRole("button", { name: "Open manager" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "null")), identity, "Open switches a remote selection to the same local pane");
  await openDialog();
  await dialog.getByRole("button", { name: "Stop manager" }).click();
  await dialog.getByText("Manager status: stopped").waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Open manager" }).count(), 0, "stopped pane cannot be opened");
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await dialog.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "manager-stopped.png") });
  }
  assert.deepEqual(errors, [], "no uncaught browser errors");
  console.log("PASS manager absent → start → open/reuse → stale identity refused → stop (fictional demo only)");
  await context.close();
} finally {
  await browser?.close();
  server.stop(true);
}
