import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { flickVelocity, onDroplet, type PressSample, type QueuedDroplet } from "../lib/droplet.ts";
import {
  DRAG_SPRING, GROW_SPRING, HIDE_SPRING, REVEAL_DELAY, REVEAL_SPRING, SHRINK_DELAY, SHRINK_SPRING,
  Spring, contentStyle, islandLayout, islandShape, type IslandLayout,
} from "../lib/dropletMotion.ts";
import { useT } from "../lib/i18n.ts";
import { AgentMark } from "./AgentMark.tsx";
import "./Droplet.css";

/**
 * The phone's in-app alert (lib/droplet.ts), as the iPhone's Dynamic Island shows one
 * (lib/dropletMotion.ts): the black island grows into a wide rounded banner with the pane's name
 * and what it wants, and shrinks back when it is done. On an iPhone with an island it grows out
 * of the island; elsewhere a pill appears under the top of the screen and grows the same way.
 * One shows at a time; a newer one has the current one shrink away first. A tap opens the pane,
 * a flick up puts it away, and it leaves by itself after a while.
 */

/** how long it stays once its text shows: long enough to read a pane's name and what it wants */
export const DROPLET_HOLD_MS = 5000;
/** the longest the island takes to shrink back (SHRINK_DELAY and SHRINK_SPRING, with room) */
const EXIT_DEADLINE_MS = 1200;
/** a drag up this far, or a flick up this fast, puts it away */
const DISMISS_DRAG_PX = -18;
const DISMISS_VELOCITY = -0.42; // px per ms
/** a press that moved less than this is a tap */
const TAP_SLOP_PX = 6;

/** a touch screen gets the island; a mouse gets the toast (AlertToasts.tsx) */
export function prefersDroplet(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
}

/**
 * An iPhone in portrait whose safe area is as tall as a Dynamic Island's (59px and up; a notch is
 * 44 to 50): the alert grows out of the island itself. Anything else grows from a pill.
 */
function hasDynamicIsland(insetTop: number): boolean {
  return /iPhone/.test(navigator.userAgent) && insetTop >= 54 && window.innerHeight > window.innerWidth;
}

/** the safe area as CSS reports it: env() is readable only through a laid-out element */
function measureLayout(probe: HTMLElement | null): IslandLayout {
  const style = probe ? getComputedStyle(probe) : null;
  const px = (value: string | undefined): number => Number.parseFloat(value ?? "") || 0;
  const top = px(style?.paddingTop);
  return islandLayout(window.innerWidth, top, px(style?.paddingLeft), px(style?.paddingRight), hasDynamicIsland(top));
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

type Phase = "in" | "out";

export function Droplet({ onOpen }: { onOpen: (machineId: string, paneId: string) => void }) {
  const t = useT();
  const [current, setCurrent] = useState<QueuedDroplet | null>(null);
  const [phase, setPhase] = useState<Phase>("in");
  const [layout, setLayout] = useState<IslandLayout | null>(null);
  const pending = useRef<QueuedDroplet | null>(null);
  const currentRef = useRef(current); currentRef.current = current;
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const holdTimer = useRef<number | null>(null);
  /** an island that has not finished shrinking by then is done: animation frames stop in a hidden window */
  const exitTimer = useRef<number | null>(null);
  const probe = useRef<HTMLDivElement | null>(null);
  const islandEl = useRef<HTMLButtonElement | null>(null);
  const bodyEl = useRef<HTMLSpanElement | null>(null);
  const springs = useRef({ grow: new Spring(0), reveal: new Spring(0), drag: new Spring(0) });
  const frame = useRef<number | null>(null);
  const lastFrame = useRef(0);
  // a press that dragged ends in a click on a mouse: that click is not a tap
  const dragged = useRef(false);
  const press = useRef<{ id: number; y: number; samples: PressSample[]; moved: boolean } | null>(null);

  const paint = useCallback(() => {
    const box = layoutRef.current;
    const el = islandEl.current;
    if (!box || !el) return;
    const s = springs.current;
    const shape = islandShape(s.grow.value, box);
    el.style.left = `${shape.left}px`;
    el.style.top = `${shape.top}px`;
    el.style.width = `${shape.width}px`;
    el.style.height = `${shape.height}px`;
    el.style.borderRadius = `${shape.radius}px`;
    el.style.opacity = String(shape.opacity);
    el.style.transform = `translateY(${s.drag.value}px)`;
    const look = contentStyle(s.reveal.value);
    if (bodyEl.current) {
      bodyEl.current.style.opacity = String(look.opacity);
      bodyEl.current.style.transform = `scale(${look.scale})`;
      bodyEl.current.style.filter = look.blur > 0.05 ? `blur(${look.blur}px)` : "";
    }
  }, []);

  const settle = useRef<() => void>(() => {});
  const run = useCallback(() => {
    if (frame.current !== null) return;
    lastFrame.current = performance.now();
    const tick = (now: number): void => {
      const s = springs.current;
      let moving = false;
      for (const spring of [s.grow, s.reveal, s.drag]) moving = spring.step(lastFrame.current, now) || moving;
      lastFrame.current = now;
      paint();
      if (moving) frame.current = requestAnimationFrame(tick);
      else {
        frame.current = null;
        if (phaseRef.current === "out") settle.current();
      }
    };
    frame.current = requestAnimationFrame(tick);
  }, [paint]);

  const clearHold = (): void => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };

  const leave = useCallback(() => {
    if (!currentRef.current || phaseRef.current === "out") return;
    clearHold();
    phaseRef.current = "out";
    setPhase("out");
    const s = springs.current;
    const now = performance.now();
    s.reveal.to(0, HIDE_SPRING, now);
    s.grow.to(0, reducedMotion() ? HIDE_SPRING : SHRINK_SPRING, now, SHRINK_DELAY);
    s.drag.to(0, DRAG_SPRING, now);
    run();
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = null;
      if (phaseRef.current !== "out") return;
      if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
      settle.current();
    }, EXIT_DEADLINE_MS);
  }, [run]);

  const hold = useCallback((ms: number) => {
    clearHold();
    holdTimer.current = window.setTimeout(leave, ms);
  }, [leave]);

  const enter = useCallback(() => {
    const s = springs.current;
    for (const spring of [s.grow, s.reveal, s.drag]) spring.set(0);
    const now = performance.now();
    if (reducedMotion()) {
      // no growth: the banner fades in where it rests
      s.grow.set(1);
      s.reveal.to(1, HIDE_SPRING, now);
    } else {
      s.grow.to(1, GROW_SPRING, now);
      s.reveal.to(1, REVEAL_SPRING, now, REVEAL_DELAY);
    }
    paint();
    run();
    hold(REVEAL_DELAY + DROPLET_HOLD_MS);
  }, [hold, paint, run]);

  settle.current = () => {
    if (exitTimer.current !== null) { window.clearTimeout(exitTimer.current); exitTimer.current = null; }
    const next = pending.current;
    pending.current = null;
    phaseRef.current = "in";
    setPhase("in");
    setCurrent(next);
  };

  useEffect(() => onDroplet((notice) => {
    if (!prefersDroplet()) return;
    if (!currentRef.current) {
      setCurrent(notice);
      return;
    }
    // one at a time: the newest waits for the current one to shrink away
    pending.current = notice;
    leave();
  }), [leave]);

  // each notice starts growing once its island is in the page
  useLayoutEffect(() => {
    if (!current) return;
    setLayout(measureLayout(probe.current));
  }, [current]);
  useLayoutEffect(() => {
    if (current && layout && phaseRef.current === "in") enter();
  }, [current, layout === null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!current) return;
    const onResize = (): void => { setLayout(measureLayout(probe.current)); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [current]);
  useLayoutEffect(() => { paint(); }, [layout, paint]);

  useEffect(() => () => {
    clearHold();
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // a right-click ends in no click: holding for it would leave the island up for good
    if (phaseRef.current === "out" || event.button !== 0) return;
    dragged.current = false;
    press.current = { id: event.pointerId, y: event.clientY, samples: [{ y: event.clientY, t: event.timeStamp }], moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    clearHold(); // held while touched
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.id !== event.pointerId) return;
    const dy = event.clientY - p.y;
    if (Math.abs(dy) > TAP_SLOP_PX) p.moved = true;
    p.samples.push({ y: event.clientY, t: event.timeStamp });
    // up follows the finger, down only gives a little
    springs.current.drag.set(Math.max(-120, Math.min(24, dy < 0 ? dy : dy * 0.35)));
    paint();
  };
  const endPress = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const p = press.current;
    if (!p || p.id !== event.pointerId) return;
    press.current = null;
    const dy = event.clientY - p.y;
    const velocity = flickVelocity(p.samples, event.clientY, event.timeStamp);
    if (!cancelled && !p.moved) return; // a tap: onClick opens it
    dragged.current = true;
    if (!cancelled && (dy <= DISMISS_DRAG_PX || velocity <= DISMISS_VELOCITY)) {
      leave();
      return;
    }
    springs.current.drag.to(0, DRAG_SPRING, performance.now());
    run();
    hold(DROPLET_HOLD_MS);
  };

  if (!current) return <div ref={probe} className="droplet-probe" aria-hidden="true" />;
  const what = t(current.kind === "blocked" ? "Needs input" : current.kind === "done" ? "Finished" : "terminal ended");
  const detail = current.machine ? `${current.machine} · ${what}` : what;
  return (
    <div className="droplet" role="status" aria-live="polite" data-phase={phase} data-kind={current.kind} key={current.id}>
      <div ref={probe} className="droplet-probe" aria-hidden="true" />
      {layout && (
        <button
          ref={islandEl}
          type="button"
          className="droplet-card"
          aria-label={`${current.title}, ${detail}. ${t("Open pane")}`}
          onClick={() => {
            if (dragged.current) {
              dragged.current = false;
              return;
            }
            if (phaseRef.current === "out") return;
            onOpen(current.machineId, current.paneId);
            leave();
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => endPress(event, false)}
          onPointerCancel={(event) => endPress(event, true)}
        >
          <span ref={bodyEl} className="droplet-body">
            <span className="droplet-mark">{current.agent ? <AgentMark agent={current.agent} size={18} /> : null}</span>
            <span className="droplet-text">
              <span className="droplet-title">{current.title}</span>
              <span className="droplet-detail">{detail}</span>
            </span>
            <span className="droplet-dot" aria-hidden="true" />
          </span>
        </button>
      )}
    </div>
  );
}
