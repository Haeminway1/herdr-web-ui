import type { PaneInfo } from "./herdr-api.generated.ts";

/**
 * fork: the sidebar's resident agents. Folders on this PC whose sessions the classic sidebar keeps
 * apart: `top` ones above everything, the rest under the Resident tab, with a dim row that starts
 * a session when none is open there. Kept by the server (residents.json), so every device shows
 * the same list.
 */
export interface ResidentLaunch {
  /** the agent kind herdr starts: "claude" or "codex" */
  kind: "claude" | "codex";
  /** the model given to the agent's --model; empty for the agent's own default */
  model: string;
  /** the reasoning effort; empty for the agent's own default */
  effort: "" | "low" | "medium" | "high" | "xhigh";
}

/**
 * The server's own pin: the PC's verified native manager, bound to the pane it proved. `folder`
 * is the canonical ownership root the server checked against; the ids are that pane's. The
 * server writes it after snapshot proof — a stored or sent one is metadata, never authority.
 */
export interface SystemResidentPin {
  folder: string;
  workspace_id: string;
  pane_id: string;
  terminal_id: string;
}

export interface Residents {
  /** always on top, whichever tab is shown */
  top: string[];
  /** the Resident tab, in this order */
  residents: string[];
  /** how a dim row starts its session */
  launch: ResidentLaunch;
  /** a resident's name in the sidebar, by folder; a folder without one shows its own name */
  names: Record<string, string>;
  /** the verified native manager, kept first in `top`; null when this PC has none */
  system_pin?: SystemResidentPin | null;
}

export const DEFAULT_RESIDENTS: Residents = {
  top: [],
  residents: [],
  launch: { kind: "claude", model: "claude-opus-5-5", effort: "medium" },
  names: {},
  system_pin: null,
};

const EFFORTS = new Set(["", "low", "medium", "high", "xhigh"]);
const MAX_PATHS = 64;
const MAX_ID = 200;

function paths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const path = item.trim().replace(/\/+$/, "");
    if (path.startsWith("/") && path.length <= 1024 && !seen.has(path)) seen.add(path);
    if (seen.size >= MAX_PATHS) break;
  }
  return [...seen];
}

/** A pin worth keeping: an absolute folder plus herdr's three ids, every one present. */
function systemPin(value: unknown): SystemResidentPin | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const folder = typeof record["folder"] === "string" ? record["folder"].trim().replace(/\/+$/, "") : "";
  const workspace_id = typeof record["workspace_id"] === "string" ? record["workspace_id"].trim() : "";
  const pane_id = typeof record["pane_id"] === "string" ? record["pane_id"].trim() : "";
  const terminal_id = typeof record["terminal_id"] === "string" ? record["terminal_id"].trim() : "";
  if (!folder.startsWith("/") || folder.length > 1024 || [workspace_id, pane_id, terminal_id].some((id) => id.length === 0 || id.length > MAX_ID)) return null;
  return { folder, workspace_id, pane_id, terminal_id };
}

/** Whatever was stored or sent, as a valid record: unknown fields dropped, bad ones defaulted. */
export function sanitizeResidents(value: unknown): Residents {
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const launch = record["launch"] !== null && typeof record["launch"] === "object" ? record["launch"] as Record<string, unknown> : {};
  const top = paths(record["top"]);
  const residents = paths(record["residents"]).filter((path) => !top.includes(path));
  const named = record["names"] !== null && typeof record["names"] === "object" && !Array.isArray(record["names"]) ? record["names"] as Record<string, unknown> : {};
  const names: Record<string, string> = {};
  for (const path of [...top, ...residents]) {
    const name = named[path];
    if (typeof name === "string" && name.trim()) names[path] = name.trim().replace(/\s+/g, " ").slice(0, 60);
  }
  return {
    top,
    // a folder on top is not listed twice
    residents,
    launch: {
      kind: launch["kind"] === "codex" ? "codex" : "claude",
      model: typeof launch["model"] === "string" && /^[\w.:/-]{0,80}$/.test(launch["model"].trim()) ? launch["model"].trim() : DEFAULT_RESIDENTS.launch.model,
      effort: typeof launch["effort"] === "string" && EFFORTS.has(launch["effort"]) ? launch["effort"] as ResidentLaunch["effort"] : DEFAULT_RESIDENTS.launch.effort,
    },
    names,
    system_pin: systemPin(record["system_pin"]),
  };
}

/** The folder a pane belongs to, among the given ones: its own, or the nearest one above it. */
export function residentFolder(cwd: string | null | undefined, folders: readonly string[]): string | null {
  if (!cwd) return null;
  let best: string | null = null;
  for (const folder of folders) {
    if ((cwd === folder || cwd.startsWith(`${folder}/`)) && (best === null || folder.length > best.length)) best = folder;
  }
  return best;
}

/** The command-line arguments that start `launch`'s agent with its model and effort. */
export function launchArgs(launch: ResidentLaunch): string[] {
  const args: string[] = [];
  if (launch.kind === "claude") {
    if (launch.model) args.push("--model", launch.model);
    if (launch.effort) args.push("--effort", launch.effort);
  } else {
    if (launch.model) args.push("-m", launch.model);
    if (launch.effort) args.push("-c", `model_reasoning_effort=${launch.effort}`);
  }
  return args;
}

/** The name a resident folder shows: the one given, else the folder's own. */
export function residentName(residents: Residents, folder: string): string {
  return residents.names[folder] ?? folder.split("/").filter(Boolean).at(-1) ?? folder;
}

/**
 * The list with `pin` applied: the protected folder first on top and nowhere else. Everything
 * else — the order of the other folders, names, launch — is the user's own. A null pin clears
 * the field and leaves the lists alone.
 */
export function normalizeSystemResident(residents: Residents, pin: SystemResidentPin | null): Residents {
  if (pin === null) return { ...residents, system_pin: null };
  return {
    ...residents,
    top: [pin.folder, ...residents.top.filter((folder) => folder !== pin.folder)],
    residents: residents.residents.filter((folder) => folder !== pin.folder),
    system_pin: pin,
  };
}

/**
 * Whether `pane` is the pinned manager: the workspace, pane and terminal ids and the folder all
 * at once — a label, or the folder alone, never is.
 */
export function isSystemResidentPane(
  pin: SystemResidentPin | null | undefined,
  pane: Pick<PaneInfo, "workspace_id" | "pane_id" | "terminal_id" | "cwd">,
): boolean {
  return pin != null
    && pane.workspace_id === pin.workspace_id
    && pane.pane_id === pin.pane_id
    && pane.terminal_id === pin.terminal_id
    && pane.cwd === pin.folder;
}
