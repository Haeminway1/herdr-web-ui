import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import { onDroplet, type QueuedDroplet } from "../lib/droplet.ts";
import { useT } from "../lib/i18n.ts";
import { AgentMark } from "./AgentMark.tsx";
import { prefersDroplet } from "./Droplet.tsx";
import "./AlertToasts.css";

/**
 * The in-app alert with a mouse (a touch screen gets the drop, Droplet.tsx): toasts in the
 * bottom-right corner, as the Aquila design system's toast does. Up to three stack, newest at
 * the bottom; each slides in from the right, shows how long it stays as a shrinking line, and
 * holds while the pointer is on it. A click opens the pane, the X or a swipe right puts it away.
 */

export const TOAST_HOLD_MS = 5000;
const MAX_STACK = 3;
const LEAVE_MS = 250;
const SWIPE_PX = 80;

interface Toast extends QueuedDroplet {
  leaving: boolean;
}

export function AlertToasts({ onOpen }: { onOpen: (machineId: string, paneId: string) => void }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)));
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), LEAVE_MS);
  }, []);

  useEffect(() => onDroplet((notice) => {
    if (prefersDroplet()) return;
    setToasts((current) => {
      const next = [...current, { ...notice, leaving: false }];
      return next.length > MAX_STACK ? next.slice(next.length - MAX_STACK) : next;
    });
  }), []);

  if (toasts.length === 0) return null;
  return (
    <div className="alert-toasts" role="region" aria-label="Notifications">
      {toasts.map((toast) => <AlertToast key={toast.id} toast={toast} onDismiss={dismiss} onOpen={onOpen} />)}
    </div>
  );
}

function AlertToast({ toast, onDismiss, onOpen }: { toast: Toast; onDismiss: (id: number) => void; onOpen: (machineId: string, paneId: string) => void }) {
  const t = useT();
  const [entered, setEntered] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [paused, setPaused] = useState(false);
  const press = useRef<{ x: number; moved: boolean } | null>(null);
  const remaining = useRef(TOAST_HOLD_MS);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // the countdown stops while the pointer is on the toast, and goes on from where it was
  useEffect(() => {
    if (paused || toast.leaving) return;
    startedAt.current = performance.now();
    timer.current = window.setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      remaining.current = Math.max(0, remaining.current - (performance.now() - startedAt.current));
    };
  }, [paused, toast.leaving, toast.id, onDismiss]);

  const what = t(toast.kind === "blocked" ? "Needs input" : toast.kind === "done" ? "Finished" : "terminal ended");
  const detail = toast.machine ? `${toast.machine} · ${what}` : what;
  const shown = entered && !toast.leaving;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".alert-toast-close")) return;
    press.current = { x: event.clientX, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p) return;
    const dx = event.clientX - p.x;
    if (Math.abs(dx) > 6) p.moved = true;
    setDragX(Math.max(-24, dx));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    const dx = event.clientX - p.x;
    if (!p.moved) {
      setDragX(0);
      onOpen(toast.machineId, toast.paneId);
      onDismiss(toast.id);
      return;
    }
    if (dx > SWIPE_PX) {
      setDragX(480);
      onDismiss(toast.id);
      return;
    }
    setDragX(0);
  };

  return (
    <div
      className="alert-toast"
      role="alert"
      data-kind={toast.kind}
      data-shown={shown ? "" : undefined}
      data-dragging={press.current?.moved ? "" : undefined}
      style={{ "--toast-drag": `${dragX}px`, "--toast-hold": `${TOAST_HOLD_MS}ms` } as React.CSSProperties}
      aria-label={`${toast.title}, ${detail}. ${t("Open pane")}`}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter") { onOpen(toast.machineId, toast.paneId); onDismiss(toast.id); }
        if (event.key === "Escape") onDismiss(toast.id);
      }}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { press.current = null; setDragX(0); }}
    >
      <span className="alert-toast-mark">{toast.agent ? <AgentMark agent={toast.agent} size={18} /> : <span className="alert-toast-dot" />}</span>
      <span className="alert-toast-text">
        <span className="alert-toast-title">{toast.title}</span>
        <span className="alert-toast-detail">{detail}</span>
      </span>
      <button type="button" className="alert-toast-close icon-button" aria-label={t("Dismiss")} onClick={() => onDismiss(toast.id)}>
        <X aria-hidden="true" />
      </button>
      <span className="alert-toast-progress" data-paused={paused ? "" : undefined} aria-hidden="true" />
    </div>
  );
}
