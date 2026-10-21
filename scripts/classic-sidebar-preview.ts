import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { buildDemoApp } from "./demo-build.ts";

const PREVIEW_PATH = "/";
const FIXTURE_TRANSPORT = `<script src="./demo-transport.js"></script><script>(() => {
  if (localStorage.getItem("herdr-web-ui:resident-tab") === null) {
    localStorage.setItem("herdr-web-ui:resident-tab", "work");
  }
  const managerFolder = "/tmp/herdr-classic-sidebar-preview/manager";
  const residentFolder = "/tmp/herdr-classic-sidebar-preview/resident";
  const managerId = "classic-preview-manager";
  const residentId = "classic-preview-resident";
  const paneId = id => id + ":p1";
  const tabId = id => id + ":t1";
  const addWorkspace = ({ snapshot, id, label, path }) => {
    const workspaceTemplate = snapshot.workspaces[0];
    const paneTemplate = snapshot.panes[0];
    const tabTemplate = snapshot.tabs[0];
    const layoutTemplate = snapshot.layouts[0];
    if (!workspaceTemplate || !paneTemplate || !tabTemplate || !layoutTemplate) return;
    const workspaceId = "classic-preview-" + id;
    const currentPaneId = paneId(workspaceId);
    const currentTabId = tabId(workspaceId);
    const worktree = { checkout_path: path, is_linked_worktree: false, repo_key: "classic-preview-repo-" + id, repo_name: label, repo_root: path };
    snapshot.workspaces.push({ ...workspaceTemplate, workspace_id: workspaceId, number: snapshot.workspaces.length + 1, label, focused: false, pane_count: 1, tab_count: 1, active_tab_id: currentTabId, agent_status: id === "01" ? "working" : "unknown", worktree });
    snapshot.panes.push({ ...paneTemplate, pane_id: currentPaneId, terminal_id: workspaceId + ":terminal", workspace_id: workspaceId, tab_id: currentTabId, focused: false, cwd: path, foreground_cwd: path, label, title: label, terminal_title: label, terminal_title_stripped: label, agent: null, agent_session: null, agent_status: id === "01" ? "working" : "unknown", revision: 1 });
    snapshot.tabs.push({ ...tabTemplate, tab_id: currentTabId, workspace_id: workspaceId, number: 1, label: "1", focused: false, pane_count: 1, agent_status: "unknown" });
    snapshot.layouts.push({ ...layoutTemplate, workspace_id: workspaceId, tab_id: currentTabId, focused_pane_id: currentPaneId, panes: [{ pane_id: currentPaneId, focused: false, rect: { ...layoutTemplate.area } }], splits: [] });
  };
  const expandSnapshot = snapshot => {
    if (!snapshot || !Array.isArray(snapshot.workspaces) || snapshot.workspaces.length === 0) return snapshot;
    if (snapshot.workspaces.some(workspace => workspace.workspace_id === "classic-preview-01")) return snapshot;
    addWorkspace({ snapshot, id: "manager", label: "Manager", path: managerFolder });
    addWorkspace({ snapshot, id: "resident", label: "Resident preview", path: residentFolder });
    for (let index = 1; index <= 36; index++) {
      const suffix = String(index).padStart(2, "0");
      const label = "Classic preview workspace " + suffix;
      addWorkspace({ snapshot, id: suffix, label, path: "/tmp/herdr-classic-sidebar-preview/repositories/repository-" + suffix });
    }
    return snapshot;
  };
  const withFixtureResidents = residents => ({
    ...residents,
    top: Array.from(new Set([...(residents.top || []), managerFolder])),
    residents: [residentFolder],
    names: { ...(residents.names || {}), [residentFolder]: "Resident preview" },
    system_pin: { folder: managerFolder, workspace_id: managerId, pane_id: paneId(managerId), terminal_id: managerId + ":terminal" }
  });
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (!response.ok) return response;
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!["/api/machines", "/api/session", "/api/residents"].includes(url.pathname)) return response;
    const body = await response.json();
    if (url.pathname === "/api/machines") body.machines = body.machines.map(machine => ({ ...machine, snapshot: expandSnapshot(machine.snapshot) }));
    if (url.pathname === "/api/session") body.snapshot = expandSnapshot(body.snapshot);
    if (url.pathname === "/api/residents") Object.assign(body, withFixtureResidents(body));
    return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const enrichEvent = event => {
    if (event.type !== "message") return event;
    const body = JSON.parse(String(event.data));
    if (body.type === "machines") body.machines = body.machines.map(machine => ({ ...machine, snapshot: expandSnapshot(machine.snapshot) }));
    const message = body.type === "machine-message" ? body.message : body;
    if (message.type === "snapshot") message.snapshot = expandSnapshot(message.snapshot);
    if (body.type === "machines" || message.type === "snapshot") {
      const root = document.documentElement;
      root.dataset.classicPreviewStreamSnapshots = String(Number(root.dataset.classicPreviewStreamSnapshots || 0) + 1);
    }
    return new MessageEvent("message", { data: JSON.stringify(body) });
  };
  const wrapStream = stream => {
    const dispatch = stream.dispatchEvent.bind(stream);
    stream.dispatchEvent = event => dispatch(enrichEvent(event));
    let listener = null;
    Object.defineProperty(stream, "onmessage", {
      configurable: true,
      get: () => listener,
      set: handler => { listener = handler ? event => handler.call(stream, enrichEvent(event)) : null; }
    });
    return stream;
  };
  for (const [name, suffix] of [["WebSocket", "/ws"], ["EventSource", "/api/machines/events"]]) {
    window[name] = new Proxy(window[name], {
      construct(target, args, newTarget) {
        const stream = Reflect.construct(target, args, newTarget);
        return String(args[0]).endsWith(suffix) ? wrapStream(stream) : stream;
      }
    });
  }
})();</script>`;

export interface ClassicSidebarPreviewOptions {
  readonly hostname: string;
  readonly port: number;
}

export interface ClassicSidebarDemo {
  readonly url: string;
  close(): void;
}

function injectFixtureTransport(appDir: string): void {
  const indexFile = join(appDir, "index.html");
  const html = readFileSync(indexFile, "utf8");
  const moduleScript = /<script type="module"/;
  if (!moduleScript.test(html)) throw new Error("demo index has no module entry");
  writeFileSync(indexFile, html.replace(moduleScript, `${FIXTURE_TRANSPORT}\n    <script type="module"`));
}

function servePreview(appDir: string, options: ClassicSidebarPreviewOptions): ClassicSidebarDemo {
  const root = resolve(appDir);
  let closed = false;
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    async fetch(request) {
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
      const url = new URL(request.url);
      let name: string;
      try { name = decodeURIComponent(url.pathname.slice(PREVIEW_PATH.length)); }
      catch { return new Response("bad path", { status: 400 }); }
      if (name.includes("\\") || name.includes("\0") || name.split("/").some(part => part === "." || part === "..")) return new Response("bad path", { status: 400 });
      if (!name || name.endsWith("/")) name += "index.html";
      const filePath = resolve(root, name);
      const rel = relative(root, filePath);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return new Response("bad path", { status: 400 });
      const file = Bun.file(filePath);
      return await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  return {
    url: new URL(PREVIEW_PATH, server.url).href,
    close() {
      if (closed) return;
      closed = true;
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function createClassicSidebarDemo(options: ClassicSidebarPreviewOptions): Promise<ClassicSidebarDemo> {
  const appDir = mkdtempSync(join(tmpdir(), "herdr-classic-sidebar-"));
  try {
    await buildDemoApp(appDir);
    mkdirSync(appDir, { recursive: true });
    injectFixtureTransport(appDir);
    return servePreview(appDir, options);
  } catch (error) {
    rmSync(appDir, { recursive: true, force: true });
    throw error;
  }
}

function previewOptions(args: readonly string[]): ClassicSidebarPreviewOptions {
  let hostname = "127.0.0.1";
  let port = 0;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === undefined) continue;
    const [key, inlineValue] = argument.split("=", 2);
    if (key !== "--host" && key !== "--port") throw new Error(`unknown option: ${args[index]}`);
    const value = inlineValue ?? args[index + 1];
    if (!value) throw new Error(`${key} needs a value`);
    if (inlineValue === undefined) index++;
    if (key === "--host") hostname = value;
    else {
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535");
    }
  }
  return { hostname, port };
}

if (import.meta.main) {
  const demo = await createClassicSidebarDemo(previewOptions(process.argv.slice(2)));
  console.log(`Classic sidebar fixture preview: ${demo.url}`);
  await new Promise<void>(resolveExit => {
    const stop = (): void => resolveExit();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  demo.close();
}
