import { useEffect, useId, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { alertLog, useAlertLog, type AlertEntry } from "../lib/alertLog.ts";
import { currentLocale, useT } from "../lib/i18n.ts";
import { AgentMark } from "./AgentMark.tsx";
import "./AlertBell.css";

/**
 * The header's bell: the alerts this device heard (lib/alertLog.ts) with how many are new, and the
 * switch that turns alerts on or off. A click on an alert opens its pane; opening the list marks
 * them read.
 */

export interface BellState {
  label: string;
  title: string;
  on: boolean;
  run: () => Promise<unknown>;
}

function ago(t: ReturnType<typeof useT>, at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 2) return t("just now");
  if (minutes < 60) return t("{n} min ago", { n: minutes });
  if (minutes < 60 * 24) return t("{n} h ago", { n: Math.round(minutes / 60) });
  return new Date(at).toLocaleDateString(currentLocale());
}

export function AlertBell({ bell, canToggle, onOpen }: { bell: BellState; canToggle: boolean; onOpen: (machineId: string, paneId: string) => void }) {
  const t = useT();
  const entries = useAlertLog();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const unread = entries.filter((entry) => !entry.read).length;

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
      alertLog.markAllRead(); // seen once the list closes, so the new ones still stand out while it is open
    };
  }, [open]);

  const what = (entry: AlertEntry): string => {
    const kind = t(entry.kind === "blocked" ? "Needs input" : entry.kind === "done" ? "Finished" : "terminal ended");
    return entry.machine ? `${entry.machine} · ${kind}` : kind;
  };
  const now = Date.now();

  return (
    <div className="alert-bell" ref={root}>
      <button
        type="button"
        className={`icon-button alert-bell-button${bell.on ? " is-on" : ""}`}
        data-alerts={bell.on ? "on" : "off"}
        aria-label={unread > 0 ? t("Alerts, {n} new", { n: unread }) : t("Alerts")}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={t("Alerts")}
        onClick={() => setOpen(!open)}
      >
        <Bell />
        {unread > 0 && <span className="alert-bell-count" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div id={listId} className="alert-bell-panel menu" role="dialog" aria-label={t("Alerts")}>
          <header className="alert-bell-head">
            <span>{t("Alerts")}</span>
            {entries.length > 0 && <button type="button" className="btn btn-ghost alert-bell-clear" onClick={() => alertLog.clear()}>{t("Clear")}</button>}
          </header>
          {canToggle && (
            <button type="button" className="alert-bell-switch bell-button" aria-pressed={bell.on} aria-label={bell.label} title={bell.title} onClick={() => void bell.run()}>
              <span className="alert-bell-switch-dot" data-on={bell.on ? "" : undefined} aria-hidden="true" />
              {bell.label}
            </button>
          )}
          {entries.length === 0
            ? <p className="alert-bell-empty">{t("No alerts yet")}</p>
            : (
              <ul className="alert-bell-list">
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`alert-bell-item${entry.read ? "" : " is-new"}`}
                      data-kind={entry.kind}
                      onClick={() => { setOpen(false); onOpen(entry.machineId, entry.paneId); }}
                    >
                      <span className="alert-bell-mark">{entry.agent ? <AgentMark agent={entry.agent} size={16} /> : <span className="alert-bell-dot" />}</span>
                      <span className="alert-bell-text">
                        <span className="alert-bell-title">{entry.title}</span>
                        <span className="alert-bell-what">{what(entry)}</span>
                      </span>
                      <time className="alert-bell-time" dateTime={new Date(entry.at).toISOString()}>{ago(t, entry.at, now)}</time>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </div>
  );
}
