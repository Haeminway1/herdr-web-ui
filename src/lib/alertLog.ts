import { useSyncExternalStore } from "react";
import type { DropletKind } from "./droplet.ts";

/**
 * The alerts this device heard about, newest first: what the in-app alert, a tab notification or a
 * push said, kept so one that went by unseen can be found again (components/AlertBell.tsx). Kept in
 * this browser only, the last MAX_ENTRIES, and marked read once the list is opened.
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

export const MAX_ENTRIES = 30;
const KEY = "herdr-web-ui:alert-log";
/** the same alert for the same pane this soon again is one entry */
const REPEAT_MS = 2_000;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export class AlertLog {
  private entries: AlertEntry[] | null = null;
  private listeners = new Set<() => void>();
  constructor(private storage: () => Storage = () => window.localStorage) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  read = (): AlertEntry[] => {
    if (this.entries === null) {
      try {
        const stored: unknown = JSON.parse(this.storage().getItem(KEY) ?? "[]");
        this.entries = Array.isArray(stored) ? stored.filter(valid).slice(0, MAX_ENTRIES) : [];
      } catch {
        this.entries = [];
      }
    }
    return this.entries;
  };

  private write(next: AlertEntry[]): void {
    this.entries = next;
    try { this.storage().setItem(KEY, JSON.stringify(next)); } catch { /* kept for this page only */ }
    for (const listener of this.listeners) listener();
  }

  /** `read`: the user is looking at that pane already */
  add(entry: Omit<AlertEntry, "id" | "read">, read = false): void {
    const entries = this.read();
    const last = entries.find((other) => other.machineId === entry.machineId && other.paneId === entry.paneId && other.kind === entry.kind);
    if (last && entry.at - last.at < REPEAT_MS) return;
    this.write([{ ...entry, id: `${entry.at}-${entry.machineId}-${entry.paneId}-${entry.kind}`, read }, ...entries].slice(0, MAX_ENTRIES));
  }

  markAllRead(): void {
    const entries = this.read();
    if (entries.every((entry) => entry.read)) return;
    this.write(entries.map((entry) => (entry.read ? entry : { ...entry, read: true })));
  }

  clear(): void {
    this.write([]);
  }
}

function valid(value: unknown): value is AlertEntry {
  const entry = value as Partial<AlertEntry> | null;
  return typeof entry === "object" && entry !== null && typeof entry.id === "string" && typeof entry.at === "number"
    && typeof entry.paneId === "string" && typeof entry.machineId === "string" && typeof entry.title === "string"
    && (entry.kind === "blocked" || entry.kind === "done" || entry.kind === "ended");
}

export const alertLog = new AlertLog();

export function useAlertLog(): AlertEntry[] {
  return useSyncExternalStore(alertLog.subscribe, alertLog.read);
}
