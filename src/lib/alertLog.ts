import { useSyncExternalStore } from "react";
import type { DropletKind } from "./droplet.ts";

/**
 * The alerts this device heard about, newest first: what the in-app alert, a tab notification or a
 * push said, kept so one that went by unseen can be found again (components/AlertBell.tsx). Kept in
 * this browser only, the last MAX_ENTRIES, and marked read once the list is opened. A push that
 * came while no page ran is written down by the service worker and merged in here
 * (lib/pushedAlerts.ts).
 */

export interface AlertEntry {
  id: string;
  at: number;
  machineId: string;
  paneId: string;
  agent: string | null;
  title: string;
  /** the PC's name, when there is more than one */
  machine: string | null;
  kind: DropletKind;
  read: boolean;
}

export type NewAlert = Omit<AlertEntry, "id" | "read">;

export const MAX_ENTRIES = 30;
export const KEY = "herdr-web-ui:alert-log";
/** the same alert for the same pane this soon again is one entry */
const REPEAT_MS = 2_000;
/**
 * A push the page also heard live is one entry: the push carries when the server saw it, the
 * page's entry when its stream did, and a phone's clock can be some seconds off the PC's.
 */
export const MERGE_MS = 15_000;
/** A time the list can show: new Date(at).toISOString() throws past 8.64e15. */
export function validTime(at: unknown): at is number {
  return typeof at === "number" && Number.isFinite(at) && at > 0 && at <= 8.64e15;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const same = (a: NewAlert, b: NewAlert): boolean => a.machineId === b.machineId && a.paneId === b.paneId && a.kind === b.kind;
const idOf = (entry: NewAlert): string => `${entry.at}-${entry.machineId}-${entry.paneId}-${entry.kind}`;

export class AlertLog {
  private entries: AlertEntry[] | null = null;
  private raw: string | null = null;
  private listeners = new Set<() => void>();
  constructor(private storage: () => Storage = () => window.localStorage) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  read = (): AlertEntry[] => this.entries ?? this.load();

  /** Another tab changed the list: show what it wrote. */
  reload(): void {
    this.load();
    for (const listener of this.listeners) listener();
  }

  // Every change starts from what storage holds now, so one tab does not write over another's alerts.
  // The same stored text keeps the same list, so a look that found nothing new changes nothing.
  private load(): AlertEntry[] {
    try {
      const raw = this.storage().getItem(KEY);
      if (this.entries !== null && raw === this.raw) return this.entries;
      this.raw = raw;
      const stored: unknown = JSON.parse(raw ?? "[]");
      this.entries = Array.isArray(stored) ? stored.filter(valid).slice(0, MAX_ENTRIES) : [];
    } catch {
      this.entries ??= [];
    }
    return this.entries;
  }

  private write(next: AlertEntry[]): void {
    this.entries = next;
    const raw = JSON.stringify(next);
    try { this.storage().setItem(KEY, raw); this.raw = raw; } catch { /* kept for this page only */ }
    for (const listener of this.listeners) listener();
  }

  /** `read`: the user is looking at that pane already */
  add(entry: NewAlert, read = false): void {
    const entries = this.load();
    const last = entries.find((other) => same(other, entry));
    if (last && entry.at - last.at < REPEAT_MS) {
      // a repeat is one entry, but one the user has not seen yet is new again
      if (last.read && !read) this.write(entries.map((other) => (other === last ? { ...other, read: false } : other)));
      return;
    }
    this.write([{ ...entry, id: idOf(entry), read }, ...entries].slice(0, MAX_ENTRIES));
  }

  /** Alerts a push brought (lib/pushedAlerts.ts), new unless the page heard them live too. */
  merge(pushed: readonly NewAlert[]): void {
    let entries = this.load();
    let added = false;
    for (const entry of pushed) {
      if (entries.some((other) => same(other, entry) && Math.abs(other.at - entry.at) < MERGE_MS)) continue;
      entries = [...entries, { ...entry, id: idOf(entry), read: false }];
      added = true;
    }
    if (added) this.write(entries.sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES));
  }

  markAllRead(): void {
    const entries = this.load();
    if (entries.every((entry) => entry.read)) return;
    this.write(entries.map((entry) => (entry.read ? entry : { ...entry, read: true })));
  }

  clear(): void {
    this.write([]);
  }
}

function valid(value: unknown): value is AlertEntry {
  const entry = value as Partial<AlertEntry> | null;
  return typeof entry === "object" && entry !== null && typeof entry.id === "string"
    && validTime(entry.at)
    && typeof entry.paneId === "string" && typeof entry.machineId === "string" && typeof entry.title === "string"
    && typeof entry.read === "boolean"
    && (entry.agent === null || typeof entry.agent === "string") && (entry.machine === null || typeof entry.machine === "string")
    && (entry.kind === "blocked" || entry.kind === "done" || entry.kind === "ended");
}

export const alertLog = new AlertLog();
// the list is shared by this browser's tabs: one that changed it tells the others through storage
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === KEY || event.key === null) alertLog.reload();
});

export function useAlertLog(): AlertEntry[] {
  return useSyncExternalStore(alertLog.subscribe, alertLog.read);
}
