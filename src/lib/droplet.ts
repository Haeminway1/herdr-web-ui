import type { AgentStatus } from "../../shared/protocol.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";

/**
 * In-app alerts: a notice that drops from the top edge while the app is on screen.
 * A push to a device whose app is visible arrives silent (public/sw.js), and the tab
 * alerts stay quiet in a visible tab (lib/notifications.ts), so without this an agent
 * that waits on the user while the app is open says so nowhere but its sidebar row.
 *
 * App decides what is news (shared/notify-policy.ts, as the other alerts do) and calls
 * showDroplet(); components/Droplet.tsx is the one place that draws them.
 */

export type DropletKind = "blocked" | "done" | "ended";

export interface DropletNotice {
  machineId: string;
  paneId: string;
  agent: string | null;
  /** the pane's name, as the sidebar shows it */
  title: string;
  /** the machine's name, shown beside what happened when there is more than one */
  machine: string | null;
  kind: DropletKind;
}

export interface QueuedDroplet extends DropletNotice {
  id: number;
}

/** A finished turn this long or longer is a "long turn" (server/push.ts DEFAULT_ALERT_TIMING.longTurn). */
export const LONG_TURN_MS = 60_000;
/** The same notice for the same pane this soon again is one notice. */
export const DROPLET_REPEAT_MS = 400;

/**
 * Whether this device wants to hear about a status at all, the finished-turn length included:
 * `worked` is how long the pane worked before it finished, null when this page did not see
 * it start (then it is told, as the server does).
 */
export function dropletAllows(prefs: AlertPrefs, status: AgentStatus, worked: number | null): boolean {
  if (status === "blocked") return prefs.input;
  if (status !== "done" || prefs.done === "off") return false;
  if (prefs.done === "always") return true;
  return worked === null || worked >= LONG_TURN_MS;
}

/**
 * When a pane's turn began, by pane, so a finished one knows how long it worked: from working
 * or blocked entered until it is at rest again, as server/push.ts measures it. Returns how
 * long the turn took when the pane comes to rest, null while busy or when its start was not seen.
 */
export function trackTurn(started: Map<string, number>, key: string, previous: AgentStatus | undefined, next: AgentStatus, now: number): number | null {
  const busy = (value: AgentStatus | undefined): boolean => value === "working" || value === "blocked";
  if (busy(next)) {
    // a first sighting mid-turn has no start: its length stays unknown
    if (previous !== undefined && !busy(previous)) started.set(key, now);
    return null;
  }
  const since = started.get(key);
  started.delete(key);
  return since === undefined ? null : now - since;
}

type Listener = (notice: QueuedDroplet) => void;
const listeners = new Set<Listener>();
let nextId = 1;
const lastShown = new Map<string, number>();

/** Shows a notice in the open app; false when nothing draws them (no Droplet mounted) or it repeats one just shown. */
export function showDroplet(notice: DropletNotice, now = Date.now()): boolean {
  if (listeners.size === 0) return false;
  const key = `${notice.machineId}\n${notice.paneId}\n${notice.kind}`;
  const last = lastShown.get(key);
  if (last !== undefined && now - last < DROPLET_REPEAT_MS) return false;
  lastShown.set(key, now);
  const queued = { ...notice, id: nextId++ };
  for (const listener of listeners) listener(queued);
  return true;
}

export function onDroplet(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
