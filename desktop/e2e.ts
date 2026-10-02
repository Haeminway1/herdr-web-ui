/**
 * The shell against a real web ui on owned herdr panes (run from the repository root, after
 * `bun run build` and `npm install --prefix desktop`; on Linux under xvfb-run):
 *   xvfb-run -a bun desktop/e2e.ts
 * It checks what the shell adds over a browser tab: the page sees herdrDesktop and skips web
 * push; an alert with the window hidden reaches the shell as a native notice; a notice's click
 * opens its pane; a picked or dropped file is named by its path, behind the prefix.
 */
import "../scripts/test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, paneRead, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-desktop-e2e-"));
const workspaces: string[] = [];
// the panes come first: the server's status stream then knows them from its start
const panes: string[] = [];
for (const name of ["open", "other"]) {
  const cwd = join(root, name);
  mkdirSync(cwd);
  const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-desktop-${name}` });
  workspaces.push(created.workspace.workspace_id);
  panes.push(created.root_pane.pane_id);
}
const [openPane, otherPane] = panes as [string, string];
const report = (pane: string, state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
await report(openPane, "idle");
await report(otherPane, "idle");
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
const origin = `http://127.0.0.1:${server.port}/`;
const profile = join(root, "profile");
mkdirSync(profile);
writeFileSync(join(profile, "config.json"), JSON.stringify({ url: origin, pathPrefix: "laptop:", openAtLogin: false }));

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(50);
  }
}

const app = await electron.launch({
  executablePath: join(import.meta.dir, "node_modules", "electron", "dist", "electron"),
  args: [import.meta.dir, "--no-sandbox"],
  env: { ...process.env, HERDR_DESKTOP_PROFILE: profile },
});
try {

  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate((pane) => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertDone: "off" }));
    sessionStorage.setItem("herdr-web-ui:selection", JSON.stringify({ machine_id: "local", pane_id: pane }));
    localStorage.setItem(`herdr-web-ui:view:${pane}`, "chat");
  }, openPane);
  await page.reload();
  await page.locator(".conn-live").waitFor();
  assert.deepEqual(await page.evaluate(() => Object.keys((window as { herdrDesktop?: object }).herdrDesktop ?? {}).sort()), ["nameFiles", "notify", "onSelectPane"]);
  assert.equal(await page.evaluate(() => "herdrSetup" in window), false, "a served page never gets the shell's settings");
  console.log("PASS the page sees the shell, and not its settings");

  // hidden in the tray: an agent that waits reaches the shell as a native notice
  await app.evaluate(({ ipcMain, Notification }) => {
    (globalThis as { notices?: unknown[] }).notices = [];
    // what the shell shows: Notification.show, seen from the main process
    const show = Notification.prototype.show;
    Notification.prototype.show = function (this: { title: string; body: string }) {
      (globalThis as unknown as { notices: unknown[] }).notices.push({ title: this.title, body: this.body });
      return show.call(this);
    };
    ipcMain.on("herdr:notify", (_event, notice) => (globalThis as unknown as { requests: unknown[] }).requests.push(notice));
    (globalThis as { requests?: unknown[] }).requests = [];
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
  await report(otherPane, "working");
  await page.locator(`.pane-item:has(.pane-select[title^="${otherPane} —"]) [data-status="working"]`).first().waitFor({ state: "attached" });
  await report(otherPane, "blocked");
  await until(async () => (await app.evaluate(() => (globalThis as { notices?: unknown[] }).notices?.length ?? 0)) > 0, "a native notice").catch(async (error) => {
    console.log("requests", await app.evaluate(() => (globalThis as { requests?: unknown[] }).requests), await app.evaluate(({ BrowserWindow, Notification }) => ({ supported: Notification.isSupported(), visible: BrowserWindow.getAllWindows()[0]!.isVisible(), focused: BrowserWindow.getAllWindows()[0]!.isFocused() })), await page.locator(`.pane-item:has(.pane-select[title^="${otherPane} —"]) [data-status]`).first().getAttribute("data-status"));
    throw error;
  });
  const [notice] = await app.evaluate(() => (globalThis as unknown as { notices: Array<Record<string, string>> }).notices);
  const [request] = await app.evaluate(() => (globalThis as unknown as { requests: Array<Record<string, string>> }).requests);
  assert.equal(request!.pane_id, otherPane);
  assert.equal(notice!.body, "waiting for your input");
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, "closing to the tray keeps the window");
  console.log("PASS an alert with the window in the tray reaches the shell as a native notice");

  // its click: the shell shows the window and names the pane
  await app.evaluate(({ BrowserWindow }, target) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.show();
    win.webContents.send("herdr:select-pane", target);
  }, { machine_id: "local", pane_id: otherPane });
  await until(async () => JSON.parse(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection") ?? "null"))?.pane_id === otherPane, "the clicked pane opens");
  console.log("PASS a notice's click opens its pane");

  // a file picked from this computer goes in by its path, behind the prefix: nothing uploaded
  const file = join(root, "report final.pdf");
  writeFileSync(file, "%PDF-1.4\n");
  const uploads: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/pane/image") || request.url().includes("/upload")) uploads.push(request.url()); });
  await page.getByTitle("Chat transcript (Ctrl+Shift+J)", { exact: true }).or(page.getByTitle("Chat transcript (⌘⇧J)", { exact: true })).click();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.waitFor();
  await page.locator('.composer input[type="file"]').setInputFiles(file);
  await until(async () => (await composer.inputValue()).includes("report final.pdf"), "the picked file's name");
  assert.equal((await composer.inputValue()).trim(), `"laptop:${file}"`);
  assert.deepEqual(uploads, []);
  console.log("PASS a picked file goes in by its path behind the prefix, uploading nothing");

  // the same through a drop on the terminal: shell-quoted, no Enter
  await composer.fill("");
  await page.getByTitle("Live terminal (Ctrl+Shift+J)", { exact: true }).or(page.getByTitle("Live terminal (⌘⇧J)", { exact: true })).click();
  await page.locator(".pane-terminal").waitFor();
  const dropped = await page.evaluate(async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "e2e-drop-source";
    document.body.append(input);
    return true;
  });
  assert.equal(dropped, true);
  const chooser = page.locator("#e2e-drop-source");
  await chooser.setInputFiles(file);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#e2e-drop-source")!;
    if ((input.files?.length ?? 0) !== 1) throw new Error(`picked ${input.files?.length ?? 0} files`);
    const data = new DataTransfer();
    for (const picked of Array.from(input.files ?? [])) data.items.add(picked);
    const host = document.querySelector(".pane-terminal")!;
    host.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    input.remove();
  });
  // the pane's shell echoes what was typed: the quoted name, and nothing run (no Enter)
  const screen = async () => ((await paneRead({ paneId: otherPane })) as { text?: string }).text ?? "";
  await until(async () => (await screen()).includes(`'laptop:${file}'`), "the dropped file's name in the terminal").catch(async (error) => {
    console.log("screen", JSON.stringify(await screen()), await page.evaluate(() => ({ banners: Array.from(document.querySelectorAll("[class*=banner]")).map((b) => b.className + ":" + b.textContent), stack: document.querySelector(".terminal-stack")?.outerHTML.slice(0, 300) })));
    throw error;
  });
  await Bun.sleep(500);
  assert.ok(!/No such file|not found/.test(await screen()), "a drop never presses Enter");
  console.log("PASS a file dropped on the terminal goes in by its path, quoted, without Enter");
  assert.deepEqual(errors, []);
} finally {
  await app.close().catch(() => undefined);
  server.stop();
  for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
