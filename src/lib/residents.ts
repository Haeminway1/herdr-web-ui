import { useEffect, useSyncExternalStore } from "react";

import { DEFAULT_RESIDENTS, normalizeSystemResident, sanitizeResidents, type Residents } from "../../shared/residents.ts";

/**
 * fork: the sidebar's resident agents (shared/residents.ts), read from and written to this PC's
 * server so every device shows the same list. One copy for the page: the sidebar and Settings
 * read it, a change is shown at once and sent; the server's answer is what stays. `system_pin`
 * is the server's own: a change keeps the pin the last answer carried and never writes one.
 */
let current: Residents = DEFAULT_RESIDENTS;
let loaded = false;
let loading: Promise<void> | null = null;
let mutating: Promise<void> = Promise.resolve();
/** bumped when a mutation starts: a read begun before it would answer with older state */
let epoch = 0;
const listeners = new Set<() => void>();
const notify = (): void => { for (const listener of listeners) listener(); };

async function load(): Promise<void> {
  const seen = epoch;
  try {
    const response = await fetch("/api/residents", { cache: "no-store" });
    if (!response.ok) return;
    const residents = sanitizeResidents(await response.json());
    loaded = true;
    // a mutation begun since this read started already holds a newer state than the answer
    if (epoch === seen) { current = residents; notify(); }
  } catch { /* offline: the last list stays */ }
}

export function refreshResidents(): Promise<void> {
  loading ??= load().finally(() => { loading = null; });
  return loading;
}

export function updateResidents(change: (residents: Residents) => Residents): Promise<void> {
  // one mutation at a time, each applying to what the one before left standing
  const run = mutating.then(async () => {
    epoch += 1;
    const before = current;
    const next = normalizeSystemResident(sanitizeResidents(change(before)), before.system_pin ?? null);
    current = next;
    notify();
    try {
      const response = await fetch("/api/residents", { method: "PUT", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(next) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      current = sanitizeResidents(await response.json());
      notify();
    } catch {
      current = before;
      notify();
      // a refusal can mean the server pinned a manager this list never carried: read it back
      // rather than keep an older or unlocked copy — after a read still in flight settles
      await (loading ?? Promise.resolve()).then(() => refreshResidents());
    }
  });
  mutating = run.then(() => undefined, () => undefined);
  return run;
}

/** The list, loaded on first use and again when the page comes back into view or online. */
export function useResidents(): { residents: Residents; loaded: boolean } {
  const residents = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current);
  useEffect(() => {
    if (!loaded) void refreshResidents();
    const onVisible = (): void => { if (document.visibilityState === "visible") void refreshResidents(); };
    const onOnline = (): void => { void refreshResidents(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, []);
  return { residents, loaded };
}

/** Puts a folder on the Resident tab, or takes it off (and off the top). The pinned manager's folder is not the user's to move. */
export function toggleResident(folder: string): Promise<void> {
  if (current.system_pin?.folder === folder) return Promise.resolve();
  return updateResidents((residents) => residents.residents.includes(folder) || residents.top.includes(folder)
    ? { ...residents, top: residents.top.filter((path) => path !== folder), residents: residents.residents.filter((path) => path !== folder) }
    : { ...residents, residents: [...residents.residents, folder] });
}
