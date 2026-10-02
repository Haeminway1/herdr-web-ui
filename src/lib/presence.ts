/**
 * While this app is on screen it shows alerts itself (components/Droplet.tsx), so it tells the
 * server, which then holds this device's pushes back (server/push.ts PRESENCE_TTL_MS): no system
 * banner on top of the app's own. It says so again every PRESENCE_EVERY_MS while visible, and
 * at once when it is hidden or closed; a word it could not send lapses on the server.
 */
export const PRESENCE_EVERY_MS = 10_000;

/** this page among the device's tabs, and the order of its reports (the server drops one that arrives late) */
const tab = Math.random().toString(36).slice(2, 12);
let seq = 0;

export function reportPresence(endpoint: string, visible: boolean): void {
  try {
    // keepalive: the word that the app was hidden must outlive the page going to sleep
    void fetch("/api/push/presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint, visible, tab, seq: ++seq }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* the lapse on the server covers it */
  }
}

export function watchPresence(endpoint: string, report: (visible: boolean) => void = (visible) => reportPresence(endpoint, visible)): () => void {
  // on screen and in front: a window behind others shows no in-app alert, so its pushes go on
  const visible = (): boolean => document.visibilityState === "visible" && document.hasFocus();
  const now = (): void => report(visible());
  const tick = (): void => { if (visible()) report(true); };
  const gone = (): void => report(false);
  now();
  const timer = window.setInterval(tick, PRESENCE_EVERY_MS);
  document.addEventListener("visibilitychange", now);
  window.addEventListener("focus", now);
  window.addEventListener("blur", now);
  window.addEventListener("pagehide", gone);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", now);
    window.removeEventListener("focus", now);
    window.removeEventListener("blur", now);
    window.removeEventListener("pagehide", gone);
    report(false);
  };
}
