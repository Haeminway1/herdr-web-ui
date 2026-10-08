import { useEffect, useSyncExternalStore } from "react";

import { DEFAULT_RESIDENTS, sanitizeResidents, type Residents } from "../../shared/residents.ts";

/**
 * fork: the sidebar's resident agents (shared/residents.ts), read from and written to this PC's
 * server so every device shows the same list. One copy for the page: the sidebar and Settings
 * read it, a change is shown at once and sent; the server's answer is what stays.
 */
let current: Residents = DEFAULT_RESIDENTS;
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = (): void => { for (const listener of listeners) listener(); };

async function load(): Promise<void> {
  try {
    const response = await fetch("/api/residents", { cache: "no-store" });
    if (response.ok) { current = sanitizeResidents(await response.json()); loaded = true; notify(); }
  } catch { /* offline: the last list stays */ }
}

export function refreshResidents(): Promise<void> {
  loading ??= load().finally(() => { loading = null; });
  return loading;
}

export async function updateResidents(change: (residents: Residents) => Residents): Promise<void> {
  const before = current;
  current = sanitizeResidents(change(current));
  notify();
  try {
    const response = await fetch("/api/residents", { method: "PUT", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(current) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    current = sanitizeResidents(await response.json());
  } catch {
    current = before;
  }
  notify();
}

/** The list, loaded on first use and again when the page comes back into view. */
export function useResidents(): { residents: Residents; loaded: boolean } {
  const residents = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current);
  useEffect(() => {
    if (!loaded) void refreshResidents();
    const onVisible = (): void => { if (document.visibilityState === "visible") void refreshResidents(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return { residents, loaded };
}

/** Puts a folder on the Resident tab, or takes it off (and off the top). */
export function toggleResident(folder: string): Promise<void> {
  return updateResidents((residents) => residents.residents.includes(folder) || residents.top.includes(folder)
    ? { ...residents, top: residents.top.filter((path) => path !== folder), residents: residents.residents.filter((path) => path !== folder) }
    : { ...residents, residents: [...residents.residents, folder] });
}
