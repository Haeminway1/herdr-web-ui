/**
 * A desktop shell around this app (desktop/ in this repository, or any other) may put a
 * `window.herdrDesktop` object in the page before it loads. It does two things a browser
 * page cannot:
 *
 * - `notify`: shows an alert as a native notification. A desktop shell has no web push,
 *   and a service worker's notifications do not reach every shell's system tray. Every alert
 *   goes to it, and it skips the ones its window shows already (in front and focused). A
 *   click comes back through `onSelectPane`, after the shell brought its window forward.
 * - `nameFiles`: names files dropped or pasted from the computer by where they are, as the
 *   shell wants an agent to read them (a path on this PC, or one it can fetch from).
 *   A browser only hands over their bytes, which this app then uploads beside the pane.
 *
 * Every member is optional, and anything that does not look right is ignored: the page
 * then behaves exactly as it does in a browser.
 */

export interface DesktopNotice {
  title: string;
  body: string;
  tag: string;
  pane_id: string;
  machine_id: string;
}

export interface DesktopTarget {
  machine_id: string;
  pane_id: string;
}

export interface HerdrDesktop {
  notify?: (notice: DesktopNotice) => void;
  onSelectPane?: (listener: (target: DesktopTarget) => void) => void;
  /** one name per file, in order, or null to upload them as a browser does */
  nameFiles?: (files: File[]) => string[] | null;
}

function shell(): HerdrDesktop | null {
  if (typeof window === "undefined") return null;
  const value = (window as { herdrDesktop?: unknown }).herdrDesktop;
  return typeof value === "object" && value !== null ? (value as HerdrDesktop) : null;
}

/** A desktop shell shows the alerts: web push (which a shell does not have) is not tried. */
export function desktopShowsAlerts(): boolean {
  return typeof shell()?.notify === "function";
}

/** Shows a notice through the desktop shell; false when there is none to show it. */
export function desktopNotify(notice: DesktopNotice): boolean {
  const notify = shell()?.notify;
  if (typeof notify !== "function") return false;
  try {
    notify(notice);
    return true;
  } catch {
    return false;
  }
}

/** The shell's notification clicks, as the service worker's messages look (lib/notificationTarget.ts). */
export function desktopSelections(): { addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void } | undefined {
  const onSelectPane = shell()?.onSelectPane;
  if (typeof onSelectPane !== "function") return undefined;
  return {
    addEventListener: (_type, listener) => {
      onSelectPane((target) => {
        if (typeof target?.pane_id !== "string") return;
        listener({ data: { type: "select-pane", pane_id: target.pane_id, machine_id: typeof target.machine_id === "string" ? target.machine_id : "local" } } as MessageEvent);
      });
    },
  };
}

/** What the shell calls these files, or null: upload them. All or nothing, so one drop is never half each way. */
export function desktopFileNames(files: readonly File[]): string[] | null {
  const nameFiles = shell()?.nameFiles;
  if (files.length === 0 || typeof nameFiles !== "function") return null;
  try {
    const names = nameFiles([...files]);
    if (!Array.isArray(names) || names.length !== files.length) return null;
    return names.every((name) => typeof name === "string" && name.trim() !== "" && !/[\r\n]/.test(name)) ? names : null;
  } catch {
    return null;
  }
}

/** A name as the message box takes it: as it is, or in double quotes when it has a space. */
export function composerFileName(name: string): string {
  return /\s/.test(name) ? `"${name.replaceAll('"', '\\"')}"` : name;
}

/** A name as a shell takes it: single-quoted, as the uploaded paths are. */
export function shellFileName(name: string): string {
  return `'${name.replaceAll("'", "'\\''")}'`;
}
