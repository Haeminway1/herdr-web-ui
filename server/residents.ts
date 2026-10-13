import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { badRequest, conflictResponse, errorResponse, jsonResponse } from "./http.ts";
import { sameOrigin } from "./machine-security.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { normalizeSystemResident, sanitizeResidents, type Residents, type SystemResidentPin } from "../shared/residents.ts";

/** the agent name the native manager's control launch registers under: `hm-` + the launch label's hash */
const MANAGER_AGENT_NAME = "hm-0651225b2ed2";
/** the workspace token herdr sets on the workspace the native manager runs in */
const MANAGER_WORKSPACE_TOKEN = "hm_manager";
/** where the native manager is trusted to live; a pin anywhere else is not the server's */
const DEFAULT_MANAGER_FOLDER = join(homedir(), "dev", "agents", "herdr_manager");

/** write() rejection the route answers 409: the request dropped or demoted the pinned manager. */
export class SystemPinProtectedError extends Error {
  constructor() {
    super("the manager pin is protected");
    this.name = "SystemPinProtectedError";
  }
}

/**
 * fork: the sidebar's resident agents (shared/residents.ts), one small file in the state dir.
 *
 * When this PC's herdr proves a native manager, the store pins it: `system_pin` names the
 * verified pane and its folder is kept first on `top`. The pin is re-verified against a fresh
 * snapshot on every read and write; while herdr is unreachable or the manager is gone or
 * ambiguous, the last validated binding stands so an outage cannot unpin it. A pin in the
 * file or in a request body is only trusted once its folder is this server's ownership root.
 */
export class ResidentStore {
  private queue: Promise<void> = Promise.resolve();
  private readonly snapshot?: () => Promise<SessionSnapshot>;
  private readonly managerFolder: string;

  constructor(
    private readonly file: string,
    options: { managerFolder?: string; snapshot?: () => Promise<SessionSnapshot> } = {},
  ) {
    this.managerFolder = options.managerFolder ?? DEFAULT_MANAGER_FOLDER;
    this.snapshot = options.snapshot;
  }

  /** `path` with symlinks resolved when it exists; a missing one stands as given and is never created. */
  private canonical(path: string): string {
    const trimmed = path.replace(/\/+$/, "");
    try {
      return realpathSync(trimmed);
    } catch {
      return trimmed;
    }
  }

  /**
   * The one pane the snapshot proves is the native manager: an agent registered under
   * MANAGER_AGENT_NAME whose workspace and terminal the pane still matches, or a workspace
   * carrying the hm_manager token — either way the pane's cwd must be `root` itself. Exactly
   * one workspace and exactly one pane may qualify; anything less is no pin, never a guess.
   */
  private managerPin(snapshot: SessionSnapshot, root: string): SystemResidentPin | null {
    const workspaces = new Set<string>();
    const candidates = new Map<string, SystemResidentPin>();
    const claim = (pane: { workspace_id: string; pane_id: string; terminal_id: string; cwd?: string | null }): void => {
      if (typeof pane.cwd !== "string" || this.canonical(pane.cwd) !== root) return;
      workspaces.add(pane.workspace_id);
      candidates.set(pane.pane_id, { folder: root, workspace_id: pane.workspace_id, pane_id: pane.pane_id, terminal_id: pane.terminal_id });
    };
    for (const agent of snapshot.agents ?? []) {
      if (agent.name !== MANAGER_AGENT_NAME) continue;
      const pane = snapshot.panes.find((candidate) => candidate.pane_id === agent.pane_id);
      if (pane === undefined || pane.workspace_id !== agent.workspace_id || pane.terminal_id !== agent.terminal_id) continue;
      claim(pane);
    }
    for (const workspace of snapshot.workspaces ?? []) {
      if (workspace.tokens?.[MANAGER_WORKSPACE_TOKEN] !== "true") continue;
      // a workspace claiming the manager counts as a candidate even with no matching pane left:
      // two of them is ambiguous, and ambiguity never picks
      workspaces.add(workspace.workspace_id);
      for (const pane of snapshot.panes) {
        if (pane.workspace_id === workspace.workspace_id) claim(pane);
      }
    }
    if (workspaces.size !== 1 || candidates.size !== 1) return null;
    const [pin] = [...candidates.values()];
    const [workspaceId] = [...workspaces];
    return pin !== undefined && pin.workspace_id === workspaceId ? pin : null;
  }

  /**
   * The pin the server stands behind: the snapshot's verified manager, or — while herdr is
   * unreachable or the manager is gone or ambiguous — the file's last validated binding, and
   * only if that binding's folder is the ownership root. `saved` is already sanitized.
   */
  private async trustedPin(saved: SystemResidentPin | null): Promise<SystemResidentPin | null> {
    const root = this.canonical(this.managerFolder);
    const retained = saved !== null && saved.folder === root ? saved : null;
    let snapshot: SessionSnapshot | null = null;
    try {
      snapshot = this.snapshot ? await this.snapshot() : null;
    } catch {
      snapshot = null;
    }
    if (snapshot === null) return retained;
    return this.managerPin(snapshot, root) ?? retained;
  }

  /** One read or write at a time: a request begun earlier never overwrites a newer state. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  private load(): Residents {
    try {
      return sanitizeResidents(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      return sanitizeResidents({});
    }
  }

  private persist(residents: Residents): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(residents, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.file);
  }

  async read(): Promise<Residents> {
    return this.enqueue(async () => {
      const loaded = this.load();
      const normalized = normalizeSystemResident(loaded, await this.trustedPin(loaded.system_pin ?? null));
      // a legacy, demoted or duplicated manager file is healed on read; a foreign pin dropped
      if (JSON.stringify(normalized) !== JSON.stringify(loaded)) this.persist(normalized);
      return normalized;
    });
  }

  async write(value: unknown): Promise<Residents> {
    return this.enqueue(async () => {
      const loaded = this.load();
      // the trusted binding comes from the file and the snapshot; the body's own say-so never rules
      const pin = await this.trustedPin(loaded.system_pin ?? null);
      const requested = sanitizeResidents(value);
      if (pin !== null && (requested.top[0] !== pin.folder || requested.residents.includes(pin.folder))) {
        throw new SystemPinProtectedError();
      }
      const normalized = normalizeSystemResident(requested, pin);
      this.persist(normalized);
      return normalized;
    });
  }
}

/**
 * GET /api/residents → the list, with the verified manager pin applied (and persisted when it
 * was missing, demoted or duplicated); PUT with a whole record replaces it and answers what was
 * kept. PUT is a PC-local mutation: same-origin plus the app's machine header, like the other
 * machine routes. Refusing a demotion answers 409 and leaves the saved record untouched.
 */
export async function handleResidentsRequest(request: Request, store: ResidentStore): Promise<Response> {
  try {
    if (request.method === "GET") return jsonResponse(await store.read(), 200, { "cache-control": "no-store" });
    if (request.method !== "PUT") return badRequest("method_not_allowed", "use GET or PUT");
    if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") {
      return jsonResponse({ error: { code: "invalid_origin", message: "Use PC controls from this app" } }, 403);
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return badRequest("invalid_json", "request body must be JSON");
    }
    return jsonResponse(await store.write(payload));
  } catch (error) {
    if (error instanceof SystemPinProtectedError) return conflictResponse("system_pin_protected", "The pinned manager stays first on this PC's list; it can only be closed in herdr itself");
    return errorResponse(error);
  }
}
