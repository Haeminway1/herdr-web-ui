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

export interface Residents {
  /** always on top, whichever tab is shown */
  top: string[];
  /** the Resident tab, in this order */
  residents: string[];
  /** how a dim row starts its session */
  launch: ResidentLaunch;
}

export const DEFAULT_RESIDENTS: Residents = {
  top: [],
  residents: [],
  launch: { kind: "claude", model: "claude-opus-5-5", effort: "medium" },
};

const EFFORTS = new Set(["", "low", "medium", "high", "xhigh"]);
const MAX_PATHS = 64;

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

/** Whatever was stored or sent, as a valid record: unknown fields dropped, bad ones defaulted. */
export function sanitizeResidents(value: unknown): Residents {
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const launch = record["launch"] !== null && typeof record["launch"] === "object" ? record["launch"] as Record<string, unknown> : {};
  const top = paths(record["top"]);
  return {
    top,
    // a folder on top is not listed twice
    residents: paths(record["residents"]).filter((path) => !top.includes(path)),
    launch: {
      kind: launch["kind"] === "codex" ? "codex" : "claude",
      model: typeof launch["model"] === "string" && /^[\w.:/-]{0,80}$/.test(launch["model"].trim()) ? launch["model"].trim() : DEFAULT_RESIDENTS.launch.model,
      effort: typeof launch["effort"] === "string" && EFFORTS.has(launch["effort"]) ? launch["effort"] as ResidentLaunch["effort"] : DEFAULT_RESIDENTS.launch.effort,
    },
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
