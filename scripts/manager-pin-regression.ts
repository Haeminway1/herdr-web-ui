/**
 * Real-Chromium regression for the system manager pin (docs/manager-system-pin.md): the demo's
 * unmodified production client, plus one injected fixture script that points the app's own
 * fetch/EventSource/WebSocket traffic at fixtures carrying a synthetic manager — an agent
 * registered under the native manager name in a workspace that carries the hm_manager token, its
 * pane rooted in a temp folder this run owns — and a same-name/same-folder impostor bound to
 * different ids. /api/residents is the single live route: rewritten to /__manager__/… it passes
 * the demo transport through to this script's own loopback server, which serves it with the real
 * ResidentStore and handleResidentsRequest over a temp state file. No herdr, no user socket, no
 * real state directory is touched; every byte is synthetic and loopback-only.
 *
 * Run: bun scripts/manager-pin-regression.ts   (CHROME_PATH picks the browser; default /opt/google/chrome/chrome)
 * Evidence: evidence/manager-browser.json holds exactly the four counters (executed, failures,
 * errors, skipped); evidence/manager-pin/browser-details.json holds scenarios and checks, and
 * evidence/manager-pin/*.png the desktop and phone screenshots.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

import machinesFixture from "../site/demo/fixtures/machines.json";
import panes from "../site/demo/fixtures/panes.json";
import { handleResidentsRequest, ResidentStore } from "../server/residents.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";

const repo = join(import.meta.dir, "..");
/** the registration name the native manager claims (server/residents.ts) */
const MANAGER_AGENT_NAME = "hm-0651225b2ed2";
const MANAGER = { workspace: "w9m", tab: "w9m:t1", pane: "w9m:p1", terminal: "term-mgr-0001" };
const IMPOSTOR = { workspace: "w9i", tab: "w9i:t1", pane: "w9i:p1", terminal: "term-imp-0001" };
/** a pane of the fixture already open: the user's own resident pins point at real folders */
const USER_TOP = "/tmp/herdr-demo/web-dashboard";
const USER_RES = "/tmp/herdr-demo/infra";
/** a resident folder with no session open: the ordinary ghost that must still launch */
const GHOST_RES = "/tmp/herdr-demo/manager-qa-ghost";
const SHELL_PANE = panes.shell;

const appDir = mkdtempSync(join(tmpdir(), "herdr-manager-app-"));
const managerDir = mkdtempSync(join(tmpdir(), "herdr-manager-owned-"));
const stateDir = mkdtempSync(join(tmpdir(), "herdr-manager-state-"));
/** the ownership root, canonicalized the way ResidentStore reads the pane's cwd */
const managerFolder = realpathSync(managerDir);
const residentsFile = join(stateDir, "residents.json");

/** The records injected into every snapshot the app is handed: one real manager, one impostor. */
const injected = (folder: string) => ({
  manager: {
    workspace: { workspace_id: MANAGER.workspace, number: 90, label: "herdr-manager", focused: false, pane_count: 1, tab_count: 1, active_tab_id: MANAGER.tab, agent_status: "idle", tokens: { hm_manager: "true" } },
    tab: { tab_id: MANAGER.tab, workspace_id: MANAGER.workspace, number: 1, label: "1", focused: false, pane_count: 1, agent_status: "idle" },
    pane: { pane_id: MANAGER.pane, terminal_id: MANAGER.terminal, workspace_id: MANAGER.workspace, tab_id: MANAGER.tab, focused: false, cwd: folder, foreground_cwd: folder, label: "Manager", title: "Manager", agent: "claude", agent_status: "idle", terminal_title: "herdr manager", terminal_title_stripped: "herdr manager", revision: 1 },
    // the live registration: name + the three ids bound to the pane, cwd at the ownership root
    agent: { terminal_id: MANAGER.terminal, agent: "claude", terminal_title: "herdr manager", terminal_title_stripped: "herdr manager", agent_status: "idle", workspace_id: MANAGER.workspace, tab_id: MANAGER.tab, pane_id: MANAGER.pane, focused: false, state_change_seq: 7, cwd: folder, foreground_cwd: folder, revision: 1, name: MANAGER_AGENT_NAME, title: "Manager" },
    layout: { workspace_id: MANAGER.workspace, tab_id: MANAGER.tab, zoomed: false, area: { x: 0, y: 0, width: 120, height: 40 }, focused_pane_id: MANAGER.pane, panes: [{ pane_id: MANAGER.pane, focused: true, rect: { x: 0, y: 0, width: 120, height: 40 } }], splits: [] },
  },
  impostor: {
    workspace: { workspace_id: IMPOSTOR.workspace, number: 91, label: "herdr-manager-copy", focused: false, pane_count: 1, tab_count: 1, active_tab_id: IMPOSTOR.tab, agent_status: "idle" },
    tab: { tab_id: IMPOSTOR.tab, workspace_id: IMPOSTOR.workspace, number: 1, label: "1", focused: false, pane_count: 1, agent_status: "idle" },
    // same folder, same display name — but the pane's own ids differ and its agent's binding is forged
    pane: { pane_id: IMPOSTOR.pane, terminal_id: IMPOSTOR.terminal, workspace_id: IMPOSTOR.workspace, tab_id: IMPOSTOR.tab, focused: false, cwd: folder, foreground_cwd: folder, label: "Manager", title: "Manager", agent: "claude", agent_status: "idle", terminal_title: "herdr manager", terminal_title_stripped: "herdr manager", revision: 1 },
    agent: { terminal_id: "term-forged-000", agent: "claude", terminal_title: "herdr manager", terminal_title_stripped: "herdr manager", agent_status: "idle", workspace_id: IMPOSTOR.workspace, tab_id: IMPOSTOR.tab, pane_id: IMPOSTOR.pane, focused: false, state_change_seq: 8, cwd: folder, foreground_cwd: folder, revision: 1, name: MANAGER_AGENT_NAME, title: "Manager" },
    layout: { workspace_id: IMPOSTOR.workspace, tab_id: IMPOSTOR.tab, zoomed: false, area: { x: 0, y: 0, width: 120, height: 40 }, focused_pane_id: IMPOSTOR.pane, panes: [{ pane_id: IMPOSTOR.pane, focused: true, rect: { x: 0, y: 0, width: 120, height: 40 } }], splits: [] },
  },
});
const SYNTH = injected(managerFolder);

type SnapshotMode = "live" | "down" | "manager-absent";
let snapshotMode: SnapshotMode = "live";
/** what the ResidentStore verifies against: the demo roster plus the injected records */
const serverSnapshot = async (): Promise<SessionSnapshot> => {
  if (snapshotMode === "down") throw new Error("connect_failed: synthetic herdr outage");
  const snapshot = structuredClone(machinesFixture.machines[0]!.snapshot) as unknown as SessionSnapshot;
  if (snapshotMode === "manager-absent") return snapshot;
  for (const piece of [SYNTH.manager, SYNTH.impostor]) {
    snapshot.workspaces.push(piece.workspace as SessionSnapshot["workspaces"][number]);
    snapshot.tabs.push(piece.tab as SessionSnapshot["tabs"][number]);
    snapshot.panes.push(piece.pane as SessionSnapshot["panes"][number]);
    snapshot.agents.push(piece.agent as SessionSnapshot["agents"][number]);
    snapshot.layouts.push(piece.layout as SessionSnapshot["layouts"][number]);
  }
  return snapshot;
};

/** initial persisted state: the user's own pins and names, no system_pin yet */
const SEED = {
  top: [USER_TOP, managerFolder],
  residents: [USER_RES, GHOST_RES],
  launch: { kind: "claude", model: "claude-opus-5-5", effort: "medium" },
  names: { [USER_TOP]: "Web board", [managerFolder]: "Manager" },
};
writeFileSync(residentsFile, `${JSON.stringify(SEED)}\n`, { mode: 0o600 });
const residentsStore = new ResidentStore(residentsFile, { managerFolder, snapshot: serverSnapshot });
const expectedPin = { folder: managerFolder, workspace_id: MANAGER.workspace, pane_id: MANAGER.pane, terminal_id: MANAGER.terminal };

/** the one page-side fixture file: snapshot injection + the residents route's pass-through */
const fixtureScript = `/* generated by scripts/manager-pin-regression.ts — synthetic manager fixture */
(() => {
  "use strict";
  const SYNTH = ${JSON.stringify(SYNTH)};
  const counts = (window.__managerCounts = { workspaceCreate: 0 });
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const inject = (snapshot) => {
    if (!snapshot || !Array.isArray(snapshot.panes)) return;
    // a manager gone from the roster drops only its own piece: the impostor still lands,
    // and each piece guards its own pane id so a partial snapshot never duplicates one
    const pieces = window.__managerGone === true ? [SYNTH.impostor] : [SYNTH.manager, SYNTH.impostor];
    for (const piece of pieces) {
      if (snapshot.panes.some((pane) => pane && pane.pane_id === piece.pane.pane_id)) continue;
      snapshot.workspaces.push(clone(piece.workspace));
      snapshot.tabs.push(clone(piece.tab));
      snapshot.panes.push(clone(piece.pane));
      if (Array.isArray(snapshot.agents)) snapshot.agents.push(clone(piece.agent));
      if (Array.isArray(snapshot.layouts)) snapshot.layouts.push(clone(piece.layout));
    }
  };
  const injectMachines = (payload) => {
    if (payload && Array.isArray(payload.machines)) {
      for (const machine of payload.machines) if (machine && machine.id === "local" && machine.snapshot) inject(machine.snapshot);
    }
  };
  const demoFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    let url;
    try { url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href); }
    catch { return demoFetch(input, init); }
    if (url.pathname === "/api/residents") {
      // off the /api/ prefix the demo transport hands it to the real network: this run's server
      const target = new URL("/__manager__/api/residents", url);
      target.search = url.search;
      return demoFetch(input instanceof Request && init === undefined ? new Request(target.href, input) : target.href, init);
    }
    if (url.pathname === "/api/workspace/create" || url.pathname === "/api/worktree/open") counts.workspaceCreate += 1;
    const response = demoFetch(input, init);
    if (url.pathname !== "/api/session" && url.pathname !== "/api/machines") return response;
    return Promise.resolve(response).then(async (res) => {
      if (!res.ok) return res;
      let body;
      try { body = await res.json(); } catch { return res; }
      if (url.pathname === "/api/session") inject(body && body.snapshot); else injectMachines(body);
      return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
    });
  };
  // rewrite one message payload before the app's own handler sees it
  const patchMessage = (event, apply) => {
    if (!(event instanceof MessageEvent) || typeof event.data !== "string") return event;
    try {
      const parsed = JSON.parse(event.data);
      if (apply(parsed)) return new MessageEvent("message", { data: JSON.stringify(parsed) });
    } catch { /* not json */ }
    return event;
  };
  const watch = (endpoint) => {
    const wrapped = new WeakMap();
    let property = null;
    Object.defineProperty(endpoint, "onmessage", {
      configurable: true,
      get: () => property,
      set: (fn) => { property = typeof fn === "function" ? (event) => fn.call(endpoint, endpoint.__patch(event)) : fn; },
    });
    endpoint.__patch = (event) => patchMessage(event, endpoint.__apply);
    const add = endpoint.addEventListener.bind(endpoint);
    const remove = endpoint.removeEventListener.bind(endpoint);
    endpoint.addEventListener = (type, listener, options) => {
      if (type !== "message" || !listener) return add(type, listener, options);
      const fn = (event) => { const patched = endpoint.__patch(event); if (typeof listener === "function") listener.call(endpoint, patched); else listener.handleEvent(patched); };
      wrapped.set(listener, fn);
      return add(type, fn, options);
    };
    endpoint.removeEventListener = (type, listener, options) => remove(type, wrapped.get(listener) ?? listener, options);
    return endpoint;
  };
  const PreviousEventSource = window.EventSource;
  window.EventSource = function (url, init) {
    const source = new PreviousEventSource(url, init);
    try {
      if (new URL(String(url), location.href).pathname === "/api/machines/events") {
        source.__apply = (parsed) => { if (parsed && parsed.type === "machines") { injectMachines(parsed); return true; } return false; };
        watch(source);
      }
    } catch { /* not this demo's source */ }
    return source;
  };
  const PreviousWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const socket = new PreviousWebSocket(url, protocols);
    try {
      if (new URL(String(url), location.href).pathname === "/ws") {
        socket.__apply = (parsed) => { if (parsed && parsed.type === "snapshot" && parsed.snapshot) { inject(parsed.snapshot); return true; } return false; };
        watch(socket);
      }
    } catch { /* a real socket: leave it alone */ }
    return socket;
  };
  for (const key of Object.getOwnPropertyNames(PreviousWebSocket)) {
    if (key !== "length" && key !== "name" && key !== "prototype") window.WebSocket[key] = PreviousWebSocket[key];
  }
})();
`;

// ---- evidence ----------------------------------------------------------------------------------

const evidenceDir = join(repo, "evidence");
const shotDir = join(evidenceDir, "manager-pin");
mkdirSync(shotDir, { recursive: true });
interface Scenario { name: string; status: "pass" | "fail" | "skip"; checks: number; error?: string }
const report = {
  script: "scripts/manager-pin-regression.ts",
  started_at: new Date().toISOString(),
  executed: 0,
  failures: 0,
  errors: 0,
  skipped: 0,
  checks: 0,
  scenarios: [] as Scenario[],
  screenshots: [] as string[],
  skipped_note: "synthetic loopback evidence only; this is not a live production deployment",
};
let scenarioChecks = 0;
const ok = (value: unknown, message: string): void => { scenarioChecks++; report.checks++; assert.ok(value, message); };
const eq = (actual: unknown, expected: unknown, message: string): void => { scenarioChecks++; report.checks++; assert.equal(actual, expected, message); };
const deepEq = (actual: unknown, expected: unknown, message: string): void => { scenarioChecks++; report.checks++; assert.deepEqual(actual, expected, message); };
async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  // every attempted scenario is executed, whatever it goes on to do
  report.executed++;
  scenarioChecks = 0;
  try {
    await run();
    report.scenarios.push({ name, status: "pass", checks: scenarioChecks });
    console.log(`PASS ${name} (${scenarioChecks} checks)`);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    // one classification per attempt: an assertion is a failure, anything else an error
    if (error instanceof assert.AssertionError) report.failures++;
    else report.errors++;
    report.scenarios.push({ name, status: "fail", checks: scenarioChecks, error: message.slice(0, 2000) });
    console.error(`FAIL ${name}\n  ${message.split("\n").join("\n  ")}`);
  }
}
const screenshot = async (page: Page, name: string): Promise<void> => {
  const file = join(shotDir, `${name}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(file);
};
const writeEvidence = (): void => {
  // the gate reads this file: exactly the four counters, and failures+errors+skipped <= executed
  const body = `${JSON.stringify({ executed: report.executed, failures: report.failures, errors: report.errors, skipped: report.skipped }, null, 2)}\n`;
  writeFileSync(join(evidenceDir, "manager-browser.json"), body);
  const details = `${JSON.stringify({ ...report, finished_at: new Date().toISOString() }, null, 2)}\n`;
  writeFileSync(join(shotDir, "browser-details.json"), details);
  const mirror = process.env.UI_EVIDENCE_DIR;
  if (mirror) {
    mkdirSync(join(mirror, "manager-pin"), { recursive: true });
    writeFileSync(join(mirror, "manager-browser.json"), body);
    writeFileSync(join(mirror, "manager-pin", "browser-details.json"), details);
  }
};

// ---- server ------------------------------------------------------------------------------------

let url = "";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    // the one live API: the real resident handler over this run's own store
    if (path === "/api/residents" || path === "/__manager__/api/residents") return handleResidentsRequest(request, residentsStore);
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(appDir, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  },
});
url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;

/** a residents PUT as the client sends it: same-origin plus the machine header, over HTTP */
const putResidents = (body: unknown) =>
  fetch(`http://127.0.0.1:${server.port}/api/residents`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify(body),
  });
const getResidents = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/residents`)).json()) as {
  top: string[]; residents: string[]; names: Record<string, string>; system_pin: typeof expectedPin | null;
};
const savedFile = () => JSON.parse(readFileSync(residentsFile, "utf8")) as Record<string, unknown>;

// ---- browser helpers ---------------------------------------------------------------------------

interface PageOptions {
  settings?: Record<string, unknown>;
  mobile?: boolean;
  /** drop the manager from what this page is shown: the pin stays, the pane is a ghost */
  managerGone?: boolean;
}
const paneRow = (page: Page, paneId: string) =>
  page.locator(".cl-pane-item").filter({ has: page.locator(`.cl-pane-select[title^="${paneId} — "]`) });
/** an ordinary row found by its folder: only system and ghost rows carry data-folder, so a pane's row names its cwd in the select's title */
const paneRowByCwd = (page: Page, cwd: string) =>
  page.locator(".cl-pane-item").filter({ has: page.locator(`.cl-pane-select[title$=" — ${cwd}"]`) });
const systemRow = (page: Page) => page.locator(".cl-pane-item.is-system");
const impostorAgentRow = (page: Page) => page.locator(`.agents-sidebar .agent-item[data-pane="${IMPOSTOR.pane}"]`);

/** the phone's workspace list lives in a drawer: open it unless it already is; a desktop no-ops */
async function openDrawer(page: Page): Promise<void> {
  const toggle = page.locator('button[aria-controls="workspace-drawer"]');
  if (await toggle.count() === 0 || !(await toggle.isVisible()) || (await toggle.getAttribute("aria-expanded")) === "true") return;
  await toggle.tap();
  await page.locator("#workspace-drawer.is-open").waitFor({ timeout: 10_000 });
}

/** the Agents section starts folded in the phone's drawer: open it where it is */
async function expandAgents(page: Page): Promise<void> {
  const toggle = page.locator(".agent-section-toggle");
  if (await toggle.count() === 0 || (await toggle.getAttribute("aria-expanded")) !== "false") return;
  await toggle.click();
  await page.locator(".agents-sidebar .agent-list-contents").waitFor({ state: "visible", timeout: 10_000 });
}

async function withPage(browser: Browser, options: PageOptions, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: options.mobile ?? false,
    hasTouch: options.mobile ?? false,
    locale: "en-US",
  });
  try {
    await context.addInitScript(([stored, gone]) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", ...(stored as Record<string, unknown>) }));
      (window as unknown as { __managerGone?: boolean }).__managerGone = gone === true;
    }, [options.settings ?? {}, options.managerGone ?? false] as const);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?pane=${encodeURIComponent(SHELL_PANE)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    // a phone hides the roster behind its drawer and folds the Agents list there
    if (options.mobile) await openDrawer(page);
    await expandAgents(page);
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

/** the shared core of every sidebar mode: the pinned manager row first and alone, and the impostor left ordinary */
async function expectClassicProtection(page: Page): Promise<void> {
  const row = systemRow(page);
  await row.waitFor({ timeout: 10_000 });
  eq(await systemRow(page).count(), 1, "the system-pinned manager is drawn exactly once");
  eq(await page.locator(".cl-sidebar-list .cl-pane-item").first().evaluate((el) => el.classList.contains("is-system")), true, "the pinned manager leads the whole list");
  eq(await row.locator(`.cl-pane-lock[role="img"]`).count(), 1, "the manager row carries the lock");
  eq(await row.locator(".cl-pane-lock").getAttribute("aria-label"), "System pinned", "the lock is announced");
  eq(await row.locator(".cl-pane-actions").count(), 0, "the manager row has no pin, rename or close control");
}

// ---- run ---------------------------------------------------------------------------------------

let browser: Browser | null = null;
/** a short home for the browser's profiles when the run's own tmp dir sits too deep */
let chromeTmp: string | null = null;
try {
  await buildDemoApp(appDir);
  const index = join(appDir, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(join(appDir, "manager-fixture.js"), fixtureScript);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script src="./manager-fixture.js"></script>\n    <script type="module"'));

  // the route contract itself, before any browser opens: seed → verify → protect, all synthetic
  await scenario("api: initial state, verified pin, refused bypass and legitimate writes", async () => {
    const first = await getResidents();
    deepEq(first.system_pin, expectedPin, "GET verifies the injected manager and returns its pin");
    eq(first.top[0], managerFolder, "the manager's folder is pinned first");
    eq(first.top[1], USER_TOP, "the user's own top pin is kept");
    deepEq(first.residents, [USER_RES, GHOST_RES], "the user's resident folders are kept");
    eq(first.names[USER_TOP], "Web board", "the user's names survive");
    deepEq(savedFile()["system_pin"], expectedPin, "the verified pin is persisted, not just answered");

    const before = readFileSync(residentsFile, "utf8");
    // bypass attempts a client can send but the UI never does: omission, demotion, forged binding
    for (const [name, body] of [
      ["omission", { top: [USER_TOP], residents: [USER_RES] }],
      ["demotion", { top: [USER_TOP, managerFolder], residents: [USER_RES] }],
      ["relisting", { top: [USER_TOP], residents: [managerFolder, USER_RES] }],
      ["forged binding", { top: [USER_TOP], residents: [USER_RES], system_pin: { folder: managerFolder, workspace_id: "wX", pane_id: "wX:p9", terminal_id: "term_x" } }],
      ["forged foreign pin", { top: [USER_TOP], residents: [USER_RES], system_pin: { folder: "/tmp/elsewhere", workspace_id: "wX", pane_id: "wX:p9", terminal_id: "term_x" } }],
    ] as const) {
      const response = await putResidents(body);
      eq(response.status, 409, `${name} is refused`);
      eq(((await response.json()) as { error: { code: string } }).error.code, "system_pin_protected", `${name} gets the protection code`);
    }
    eq(readFileSync(residentsFile, "utf8"), before, "a refused write saves nothing the user did not already have");

    const written = await putResidents({
      top: [managerFolder, USER_TOP],
      residents: [USER_RES, GHOST_RES, "/tmp/herdr-demo/docs-site"],
      names: { [USER_TOP]: "Web board", [managerFolder]: "Manager" },
      launch: { kind: "codex", model: "gpt-5.5", effort: "high" },
    });
    eq(written.status, 200, "a write that keeps the manager first is accepted");
    const kept = (await written.json()) as { top: string[]; residents: string[]; system_pin: unknown; launch: { kind: string } };
    eq(kept.top[0], managerFolder, "the accepted write still puts the manager first");
    ok(kept.residents.includes("/tmp/herdr-demo/docs-site"), "the user's added folder lands");
    deepEq(kept.system_pin, expectedPin, "the answer carries the server's binding, never the body's");
    eq(kept.launch.kind, "codex", "the user's launch choice is kept");
  });

  // Chrome binds its SingletonSocket inside the profile playwright makes under the system tmp
  // dir: a deeply nested TMPDIR (sandboxed checkouts) pushes it past the 108-byte unix socket
  // limit and the browser dies at launch. /proc/self/cwd names this checkout at one short fixed
  // path however deep it sits, so only then does the run put the profiles beside it.
  if (join(tmpdir(), "playwright_chromiumdev_profile-000000", "SingletonSocket").length > 96) {
    chromeTmp = join(process.cwd(), ".manager-pin-tmp");
    mkdirSync(chromeTmp, { recursive: true });
    process.env.TMPDIR = join("/proc/self/cwd", ".manager-pin-tmp");
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  try {
    // every sidebar mode faces the same phone check: 390x844 touch, the drawer its roster lives in
    for (const view of [
      { name: "desktop", mobile: false, shot: "desktop" },
      { name: "phone", mobile: true, shot: "mobile" },
    ] as const) {
      await scenario(`classic sidebar, repository mode (${view.name}): protected row, impostor ordinary, ghost launches`, async () => {
        await withPage(browser!, { settings: { sidebarLayout: "classic", sidebarGrouping: "repo" }, mobile: view.mobile }, async (page) => {
          await expectClassicProtection(page);
          // the user's own top folder leads the resident block under the system row
          const top = page.locator(".cl-resident-top .cl-pane-item").filter({ hasText: "Web board" });
          await top.waitFor();
          // the impostor — same folder and display name, other ids — stays an ordinary Work row
          await page.locator(".cl-resident-tabs").getByRole("button", { name: /^Work/ }).click();
          const impostor = paneRow(page, IMPOSTOR.pane);
          await impostor.waitFor();
          eq(await impostor.locator(".cl-pane-lock").count(), 0, "the impostor never gets the lock");
          eq(await impostor.locator(".cl-pane-pin").count(), 0, "a row sharing the protected folder gets no pin control");
          if (view.mobile) {
            // a touch row keeps its actions out of the fade: the controls exist, gesture-shown
            eq(await impostor.getByRole("button", { name: /^Rename / }).count(), 1, "the impostor keeps its rename");
            eq(await impostor.locator(".cl-pane-close").count(), 1, "the impostor keeps its close");
          } else {
            await impostor.hover();
            ok(await impostor.getByRole("button", { name: /^Rename / }).isVisible(), "the impostor keeps its rename");
            ok(await impostor.locator(".cl-pane-close").isVisible(), "the impostor keeps its close");
          }
          await impostor.locator(".cl-pane-select").click();
          eq(await impostor.locator(".cl-pane-select").getAttribute("aria-current"), "true", "the impostor is still selectable");
          // a forged same-origin PUT sent by script from inside the page is refused the same way
          const denied = await page.evaluate(async () => {
            const res = await fetch("/api/residents", {
              method: "PUT",
              headers: { "content-type": "application/json", "x-herdr-machine": "1" },
              body: JSON.stringify({ top: ["/tmp/herdr-demo/web-dashboard"], residents: ["/tmp/herdr-demo/infra"] }),
            });
            return res.status;
          });
          eq(denied, 409, "a demotion sent in-page carries a real origin and still fails");
          eq(await systemRow(page).count(), 1, "the refused write left the row alone");
          // an ordinary ghost still starts a session; the system row could never produce one
          eq(await page.evaluate(() => (window as unknown as { __managerCounts: { workspaceCreate: number } }).__managerCounts.workspaceCreate), 0, "nothing created a workspace yet");
          await openDrawer(page); // the selection above closed the phone's drawer; a desktop no-ops
          await page.locator(".cl-resident-tabs").getByRole("button", { name: /^Resident/ }).click();
          const ghost = page.locator(`.cl-pane-item.is-ghost[data-folder="${GHOST_RES}"]`);
          await ghost.waitFor();
          await ghost.locator(".cl-pane-select").click();
          await page.waitForFunction(() => (window as unknown as { __managerCounts: { workspaceCreate: number } }).__managerCounts.workspaceCreate === 1, undefined, { timeout: 10_000 });
          // the launched session is an ordinary row: no data-folder, so its select's title names it
          await paneRowByCwd(page, GHOST_RES).waitFor({ state: "attached" });
          await openDrawer(page); // the launch selected the new pane and closed the drawer again
          await paneRowByCwd(page, GHOST_RES).waitFor();
          await screenshot(page, `${view.shot}-classic-repo`);
        });
      });

      for (const grouping of ["directory", "workspace"] as const) {
        await scenario(`classic sidebar, ${grouping} grouping (${view.name}): system row protected, impostor stays ordinary`, async () => {
          await withPage(browser!, { settings: { sidebarLayout: "classic", sidebarGrouping: grouping }, mobile: view.mobile }, async (page) => {
            await expectClassicProtection(page);
            // the manager's pane is not inside any folder or workspace group
            eq(await page.locator(`.cl-directory-group .cl-pane-select[title^="${MANAGER.pane} — "], .cl-workspace .cl-pane-select[title^="${MANAGER.pane} — "]`).count(), 0, "the pinned pane is lifted out of the groups");
            const impostor = paneRow(page, IMPOSTOR.pane);
            await impostor.waitFor();
            eq(await impostor.locator(".cl-pane-lock").count(), 0, "the impostor row never shows the lock");
            eq(await page.locator(".cl-pane-item.is-system").count(), 1, "still exactly one system row");
            if (grouping === "directory") {
              const group = page.locator(".cl-directory-group").filter({ has: page.locator(`.cl-pane-select[title^="${IMPOSTOR.pane} — "]`) });
              eq(await group.getAttribute("data-directory"), managerFolder, "the impostor sits in its own folder's group");
            }
            await impostor.locator(".cl-pane-select").click();
            eq(await impostor.locator(".cl-pane-select").getAttribute("aria-current"), "true", "the impostor is selectable");
            await screenshot(page, `${view.shot}-classic-${grouping}`);
          });
        });
      }

      await scenario(`agents layout, flat list without pins (${view.name}): system row first with lock, impostor ordinary`, async () => {
        await withPage(browser!, { settings: { sidebarLayout: "agents", agentPins: false }, mobile: view.mobile }, async (page) => {
          const row = page.locator(".agents-sidebar .agent-item.is-system");
          await row.waitFor({ timeout: 10_000 });
          eq(await row.count(), 1, "the manager is one row");
          eq(await page.locator(".agents-sidebar .agent-list > li").first().evaluate((el) => el.classList.contains("is-system")), true, "the system row leads the Agents list");
          eq(await row.locator(`.agent-pin-lock[aria-label="System pinned"]`).count(), 1, "the lock stands in for a star");
          eq(await row.locator(".agent-pin-toggle").count(), 0, "the system row is never pinnable");
          eq(await page.locator(".agents-sidebar .agent-pin-toggle").count(), 0, "no stars anywhere with Pin agents off");
          const impostor = impostorAgentRow(page);
          await impostor.waitFor();
          eq(await impostor.locator(".agent-pin-lock").count(), 0, "the impostor shows no lock");
          ok((await impostor.locator(".agent-name").textContent())?.includes(MANAGER_AGENT_NAME), "the impostor even displays the same registration name");
          await screenshot(page, `${view.shot}-agents-flat`);
        });
      });

      await scenario(`agents layout, flat list with pins (${view.name}): the lock is the server's, the impostor's star stays the user's`, async () => {
        await withPage(browser!, { settings: { sidebarLayout: "agents", agentPins: true, agentOrder: "workspace" }, mobile: view.mobile }, async (page) => {
          const row = page.locator(".agents-sidebar .agent-item.is-system");
          await row.waitFor({ timeout: 10_000 });
          eq(await page.locator(".agents-sidebar .agent-list > li").first().evaluate((el) => el.classList.contains("is-system")), true, "the system row leads the Agents list");
          eq(await row.locator(`.agent-pin-lock[aria-label="System pinned"]`).count(), 1, "the lock on the system row");
          eq(await row.locator(".agent-pin-toggle").count(), 0, "no star on the system row");
          const impostor = impostorAgentRow(page);
          await impostor.waitFor();
          eq(await impostor.locator(".agent-pin-lock").count(), 0, "the impostor has no lock");
          const star = impostor.locator(".agent-pin-toggle");
          await star.waitFor();
          eq(await star.getAttribute("aria-pressed"), "false", "the impostor's own star starts unpinned");
          await screenshot(page, `${view.shot}-agents-flat-pins`);
        });
      });

      await scenario(`agents layout, cards + pins (${view.name}): impostor keeps its star across a reload`, async () => {
        await withPage(browser!, { settings: { sidebarLayout: "agents", agentCards: true, agentPins: true, sidebarGrouping: "repo", agentOrder: "workspace" }, mobile: view.mobile }, async (page) => {
          const row = page.locator(".agents-sidebar .agent-item.is-system");
          await row.waitFor({ timeout: 10_000 });
          eq(await row.locator(`.agent-pin-lock[aria-label="System pinned"]`).count(), 1, "the lock on the system row");
          eq(await row.locator(".agent-pin-toggle").count(), 0, "no star on the system row");
          const impostor = impostorAgentRow(page);
          await impostor.waitFor();
          eq(await impostor.locator(".agent-pin-lock").count(), 0, "the impostor has no lock");
          const star = impostor.locator(".agent-pin-toggle");
          await star.waitFor();
          eq(await star.getAttribute("aria-pressed"), "false", "the impostor's star starts unpinned");
          // the impostor sits inside a workspace card; pinning moves the card, not the system row —
          // a card-membership locator must name the row alone, never its .agents-sidebar ancestor
          eq(await page.locator(".agents-sidebar .agent-group").filter({ has: page.locator(`.agent-item[data-pane="${IMPOSTOR.pane}"]`) }).count(), 1, "the impostor lives in a workspace card");
          await star.click();
          await page.waitForFunction((key) => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").includes(key), `local:${IMPOSTOR.pane}`, { timeout: 10_000 });
          eq(await impostor.locator(".agent-pin-toggle").getAttribute("aria-pressed"), "true", "the ordinary pin toggles");
          await page.reload();
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await openDrawer(page);
          await expandAgents(page);
          await page.locator(".agents-sidebar .agent-item.is-system").waitFor();
          eq(await page.locator(".agents-sidebar .agent-list > li").first().evaluate((el) => el.classList.contains("is-system")), true, "the manager still leads after reload");
          await page.waitForFunction((key) => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").includes(key), `local:${IMPOSTOR.pane}`, { timeout: 10_000 });
          eq(await impostorAgentRow(page).locator(".agent-pin-toggle").getAttribute("aria-pressed"), "true", "the user's own pin survives reload beside the system pin");
          await screenshot(page, `${view.shot}-agents-cards`);
        });
      });

      await scenario(`agents layout, activity order + pins (${view.name}): the system row still leads`, async () => {
        await withPage(browser!, { settings: { sidebarLayout: "agents", agentOrder: "activity", agentPins: true }, mobile: view.mobile }, async (page) => {
          const row = page.locator(".agents-sidebar .agent-item.is-system");
          await row.waitFor({ timeout: 10_000 });
          eq(await page.locator(".agents-sidebar .agent-list > li").first().evaluate((el) => el.classList.contains("is-system")), true, "activity order never outranks the system pin");
          eq(await row.locator(`.agent-pin-lock[aria-label="System pinned"]`).count(), 1);
          const star = impostorAgentRow(page).locator(".agent-pin-toggle");
          await star.waitFor();
          eq(await impostorAgentRow(page).locator(".agent-pin-lock").count(), 0, "the impostor stays unprotected");
          await screenshot(page, `${view.shot}-agents-activity`);
        });
      });
    }

    await scenario("settings: resident list disables the manager's toggle and remove, the user's stay live", async () => {
      await withPage(browser!, { settings: { sidebarLayout: "classic", sidebarGrouping: "repo" } }, async (page) => {
        await page.locator('button[title^="Settings"]').first().click();
        await openSettingsPage(page, "Appearance");
        const managerRow = page.locator(`.settings-residents > li[title="${managerFolder}"]`);
        await managerRow.waitFor();
        const toggle = managerRow.getByRole("switch", { name: "On top" });
        eq(await toggle.isDisabled(), true, "the manager's On top toggle is disabled");
        eq(await toggle.getAttribute("aria-checked"), "true", "and it reads pinned");
        eq(await managerRow.getByRole("button", { name: "Remove" }).count(), 0, "no Remove for the system pin");
        ok((await managerRow.textContent())?.includes("System pinned"), "the row says System pinned");
        const userRow = page.locator(`.settings-residents > li[title="${USER_RES}"]`);
        eq(await userRow.getByRole("switch", { name: "On top" }).isEnabled(), true, "the user's resident keeps a live toggle");
        eq(await userRow.getByRole("button", { name: "Remove" }).count(), 1, "and its Remove");
        await userRow.getByRole("switch", { name: "On top" }).click();
        for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
          const body = await getResidents();
          if (body.top.includes(USER_RES)) break;
          await new Promise((resume) => setTimeout(resume, 50));
        }
        const body = await getResidents();
        ok(body.top.includes(USER_RES), "the user's toggle wrote through the real server");
        eq(body.top[0], managerFolder, "the manager still leads the accepted write");
      });
    });

    await scenario("manager absent from the page's snapshot: locked ghost, never launchable", async () => {
      await withPage(browser!, { settings: { sidebarLayout: "classic", sidebarGrouping: "repo" }, managerGone: true }, async (page) => {
        const ghost = page.locator(`.cl-pane-item.is-ghost[data-folder="${managerFolder}"]`);
        await ghost.waitFor({ timeout: 10_000 });
        eq(await ghost.locator(".cl-pane-lock").getAttribute("aria-label"), "System pinned", "the ghost is the system-pinned placeholder");
        eq(await ghost.locator(".cl-pane-select").isDisabled(), true, "its row is not a start button");
        const before = await page.evaluate(() => (window as unknown as { __managerCounts: { workspaceCreate: number } }).__managerCounts.workspaceCreate);
        await ghost.locator(".cl-pane-select").dispatchEvent("click");
        eq(await page.evaluate(() => (window as unknown as { __managerCounts: { workspaceCreate: number } }).__managerCounts.workspaceCreate), before, "a ghost of the pinned folder can never create a workspace");
        // the impostor remains ordinary even with no manager on screen: the fixture still injects it
        await page.locator(".cl-resident-tabs").getByRole("button", { name: /^Work/ }).click();
        const impostor = paneRow(page, IMPOSTOR.pane);
        await impostor.waitFor();
        eq(await impostor.locator(".cl-pane-lock").count(), 0, "the impostor still shows no lock");
      });
    });

    await scenario("herdr unreachable or manager gone: the last validated binding still pins and still protects", async () => {
      snapshotMode = "down";
      try {
        await withPage(browser!, { settings: { sidebarLayout: "classic", sidebarGrouping: "repo" } }, async (page) => {
          const row = systemRow(page);
          await row.waitFor({ timeout: 10_000 });
          eq(await row.locator(".cl-pane-lock").getAttribute("aria-label"), "System pinned", "an outage keeps the saved pin");
          const denied = await putResidents({ top: [USER_TOP], residents: [USER_RES] });
          eq(denied.status, 409, "the saved binding still refuses a demotion while herdr is down");
          // a reconnect asks again: still pinned from the saved binding
          await page.evaluate(() => window.dispatchEvent(new Event("online")));
          await page.waitForTimeout(100);
          eq(await systemRow(page).count(), 1, "the online refresh keeps the row");
        });
        snapshotMode = "manager-absent";
        const body = await getResidents();
        deepEq(body.system_pin, expectedPin, "a snapshot that lost the manager keeps the last binding");
        const denied = await putResidents({ top: [USER_TOP], residents: [USER_RES] });
        eq(denied.status, 409, "and still refuses");
      } finally {
        snapshotMode = "live";
      }
      const restored = await getResidents();
      deepEq(restored.system_pin, expectedPin, "recovery re-verifies the same binding");
    });

    await scenario("a second device context sees the same pin and later writes", async () => {
      const first = await browser!.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
      const second = await browser!.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
      try {
        for (const context of [first, second]) {
          await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", sidebarLayout: "classic", sidebarGrouping: "repo" })));
        }
        const pageOne = await first.newPage();
        await pageOne.goto(`${url}?pane=${encodeURIComponent(SHELL_PANE)}`);
        await pageOne.locator(".cl-pane-item.is-system").waitFor({ timeout: 10_000 });
        const written = await putResidents({
          top: [managerFolder, USER_TOP],
          residents: [USER_RES, GHOST_RES, "/tmp/herdr-demo/docs-site"],
          names: { [USER_TOP]: "Web board", [managerFolder]: "Manager" },
          launch: { kind: "claude", model: "claude-opus-5-5", effort: "medium" },
        });
        eq(written.status, 200, "a write made off this device lands");
        const pageTwo = await second.newPage();
        pageTwo.setDefaultTimeout(10_000);
        await pageTwo.goto(`${url}?pane=${encodeURIComponent(SHELL_PANE)}`);
        await pageTwo.locator(".cl-pane-item.is-system").waitFor({ timeout: 10_000 });
        await pageTwo.locator(".cl-resident-tabs").getByRole("button", { name: /^Resident/ }).click();
        // docs-site has a session open: its row is ordinary and names the folder in the select's title
        await pageTwo.locator(".cl-resident-tab .cl-pane-item").filter({ has: pageTwo.locator('.cl-pane-select[title$=" — /tmp/herdr-demo/docs-site"]') }).waitFor();
        eq(await pageTwo.locator(".cl-pane-item.is-system").count(), 1, "the other device shows the same system pin");
      } finally {
        await first.close();
        await second.close();
      }
    });

    await scenario("phone drawer, Korean UI: the lock label is localized and the row protected", async () => {
      await withPage(browser!, { settings: { sidebarLayout: "classic", sidebarGrouping: "repo", language: "ko" }, mobile: true }, async (page) => {
        // withPage already opened the drawer — tapping its toggle again would close it
        const row = page.locator(".cl-pane-item.is-system");
        await row.waitFor({ timeout: 10_000 });
        eq(await row.locator(".cl-pane-lock").getAttribute("aria-label"), "시스템 고정", "the lock label is translated");
        eq(await row.locator(".cl-pane-actions").count(), 0, "no controls on the system row");
        await screenshot(page, "mobile-classic-ko");
      });
    });
  } finally {
    await browser.close();
  }
} catch (error) {
  // setup or teardown that broke before a scenario ran is one attempted error, no more
  report.executed++;
  report.errors++;
  report.scenarios.push({ name: "setup", status: "fail", checks: scenarioChecks, error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 2000) : String(error) });
  console.error("SETUP FAILURE", error);
} finally {
  server.stop(true);
  rmSync(appDir, { recursive: true, force: true });
  rmSync(managerDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  if (chromeTmp !== null) rmSync(chromeTmp, { recursive: true, force: true });
  writeEvidence();
  console.log(`evidence: ${join(evidenceDir, "manager-browser.json")} — executed=${report.executed} failures=${report.failures} checks=${report.checks} skipped=${report.skipped}`);
}

if (report.executed === 0 || report.failures > 0 || report.errors > 0) process.exitCode = 1;
