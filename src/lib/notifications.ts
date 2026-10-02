import type { AgentStatus } from "../../shared/protocol.ts";
import { ENDED_NOTIFICATION_BODY, paneNotificationTag, statusNotificationBody } from "../../shared/notify-policy.ts";
import { desktopNotify } from "./desktop.ts";

/**
 * Tab alerts: Web Notifications for pane status transitions while this page is open
 * but hidden. A device with a push subscription (lib/push.ts) gets the same alerts from
 * the server instead, and App skips these. Notification exists only in secure contexts
 * (https or localhost) - a plain-http LAN deployment reports "unsupported" and the UI
 * hides the bell entirely.
 *
 * The transition policy is shared with the server (shared/notify-policy.ts).
 */

export { alertsAllow, shouldNotifyStatus } from "../../shared/notify-policy.ts";

export type NotificationState = "unsupported" | "default" | "granted" | "denied";

export function notificationState(): NotificationState {
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  return globalThis.Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationState> {
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  const permission = await globalThis.Notification.requestPermission();
  return permission === "granted" ? "granted" : permission === "denied" ? "denied" : "default";
}

/**
 * Shown through the service worker when there is one: Android Chrome has no
 * `new Notification()`, and the worker's notificationclick (public/sw.js) selects the
 * pane. The constructor is the fallback for a page without a worker.
 */
async function show(paneId: string, title: string, body: string, onClick?: () => void, machineId = "local"): Promise<void> {
  // a desktop shell (lib/desktop.ts) shows it natively, and says which pane a click wants. The
  // shell knows best whether its window is in front, behind others or in the tray: it decides.
  if (desktopNotify({ title, body, tag: paneNotificationTag(paneId, machineId), pane_id: paneId, machine_id: machineId })) return;
  if (typeof document !== "undefined" && !document.hidden) return; // visible tab: the UI already shows it
  if (typeof globalThis.Notification === "undefined") return;
  if (globalThis.Notification.permission !== "granted") return;
  const options: NotificationOptions = { body, tag: paneNotificationTag(paneId, machineId), data: { pane_id: paneId, machine_id: machineId }, icon: "/icons/icon-192.png?v=ram1" };
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration?.active) {
      await registration.showNotification(title, options);
      return;
    }
    const notification = new globalThis.Notification(title, options);
    notification.addEventListener("click", () => {
      window.focus();
      onClick?.();
    });
  } catch {
    /* no way to show it here: the sidebar badge still carries the change */
  }
}

export function showPaneStatusNotification(paneId: string, title: string, status: AgentStatus, onClick?: () => void, machineId = "local"): void {
  void show(paneId, title, statusNotificationBody(status), onClick, machineId);
}

export function showPaneEndedNotification(paneId: string, title: string, onClick?: () => void, machineId = "local"): void {
  void show(paneId, title, ENDED_NOTIFICATION_BODY, onClick, machineId);
}
