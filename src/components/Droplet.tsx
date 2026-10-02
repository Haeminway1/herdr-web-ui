import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { flickVelocity, onDroplet, type PressSample, type QueuedDroplet } from "../lib/droplet.ts";
import {
  COLLAPSE_SPRING, DRAG_SPRING, DROP_SPRING, ENTER_EXPAND_DELAY, ENTER_REVEAL_DELAY, ENTER_TINT_DELAY, EXIT_COLLAPSE_DELAY,
  EXIT_DROP_DELAY, EXPAND_SPRING, FADE_SPRING, GOO_BLUR, GOO_INSET_RATIO, RETURN_SPRING, REVEAL_SPRING, SHADOW_BLUR, SHADOW_DY,
  Spring, TINT_SPRING, contentStyle, dropletGeometry, dropletLayout, gooMatrix, tintColor, type DropletLayout, type Rgb,
} from "../lib/dropletMotion.ts";
import { useT } from "../lib/i18n.ts";
import { AgentMark } from "./AgentMark.tsx";
import "./Droplet.css";

/**
 * The in-app alert (lib/droplet.ts), as the Triad student app shows it (expo-dynamic-notifications,
 * lib/dropletMotion.ts): a drop grows out of the top edge on a neck of liquid, stretches as it
 * falls, turns from black to white, breaks free and spreads into a card. It hangs from the safe
 * area's top, so a Dynamic Island, a notch and a desktop window all take the same path: no device
 * is guessed. One shows at a time; a newer one folds the current one away and takes its place.
 * A tap opens the pane, a flick up puts it away, and it leaves by itself after a while.
 */

/** how long it stays once its text shows */
export const DROPLET_HOLD_MS = 3600;
/** a drag up this far, or a flick up this fast, puts it away */
const DISMISS_DRAG_PX = -18;
const DISMISS_VELOCITY = -0.42; // px per ms
/** a press that moved less than this is a tap */
const TAP_SLOP_PX = 6;
const ISLAND: Rgb = [0, 0, 0];
const CARD: Rgb = [255, 255, 255];

type Phase = "in" | "out";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** the safe area as CSS reports it: env() is readable only through a laid-out element */
function measureLayout(probe: HTMLElement | null): DropletLayout {
  const style = probe ? getComputedStyle(probe) : null;
  const px = (value: string | undefined): number => Number.parseFloat(value ?? "") || 0;
  return dropletLayout(window.innerWidth, px(style?.paddingTop), px(style?.paddingLeft), px(style?.paddingRight));
}

export function Droplet({ onOpen }: { onOpen: (machineId: string, paneId: string) => void }) {
  const t = useT();
  const [current, setCurrent] = useState<QueuedDroplet | null>(null);
  const [phase, setPhase] = useState<Phase>("in");
  const [layout, setLayout] = useState<DropletLayout | null>(null);
  const pending = useRef<QueuedDroplet | null>(null);
  const currentRef = useRef(current); currentRef.current = current;
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const holdTimer = useRef<number | null>(null);
  const probe = useRef<HTMLDivElement | null>(null);
  // the shapes and the card, moved every frame without React
  const shadowEl = useRef<SVGRectElement | null>(null);
  const neckEl = useRef<SVGRectElement | null>(null);
  const dropEl = useRef<SVGRectElement | null>(null);
  const cardEl = useRef<HTMLButtonElement | null>(null);
  const bodyEl = useRef<HTMLSpanElement | null>(null);
  const springs = useRef({ drop: new Spring(0), tint: new Spring(0), expand: new Spring(0), reveal: new Spring(0), drag: new Spring(0) });
  const frame = useRef<number | null>(null);
  const lastFrame = useRef(0);
  const dragging = useRef(false);
  // a press that dragged ends in a click on a mouse: that click is not a tap
  const dragged = useRef(false);
  const press = useRef<{ id: number; y: number; samples: PressSample[]; moved: boolean } | null>(null);

  const paint = useCallback(() => {
    const box = layoutRef.current;
    if (!box) return;
    const s = springs.current;
    const g = dropletGeometry(s.drop.value, s.expand.value, box);
    const set = (el: SVGRectElement | null, x: number, y: number, w: number, h: number, r: number): void => {
      if (!el) return;
      el.setAttribute("x", String(x)); el.setAttribute("y", String(y));
      el.setAttribute("width", String(Math.max(w, 0))); el.setAttribute("height", String(Math.max(h, 0)));
      el.setAttribute("rx", String(Math.max(r, 0)));
    };
    const lift = s.drag.value;
    set(shadowEl.current, g.x, g.y + lift, g.width, g.height, g.radius);
    shadowEl.current?.setAttribute("opacity", String(g.shadowOpacity));
    set(neckEl.current, g.neckX, g.neckY, g.neckWidth, g.neckHeight + lift, g.neckWidth / 2);
    set(dropEl.current, g.x, g.y + lift, g.width, g.height, g.radius);
    dropEl.current?.setAttribute("fill", tintColor(s.tint.value, ISLAND, CARD));
    const look = contentStyle(s.reveal.value, g);
    if (cardEl.current) cardEl.current.style.transform = `translateY(${g.offsetY + lift}px)`;
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
      for (const spring of [s.drop, s.tint, s.expand, s.reveal, s.drag]) moving = spring.step(lastFrame.current, now) || moving;
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
    if (reducedMotion()) {
      for (const spring of [s.drop, s.tint, s.expand, s.reveal]) spring.to(0, FADE_SPRING, now);
    } else {
      s.reveal.to(0, FADE_SPRING, now);
      s.expand.to(0, COLLAPSE_SPRING, now, EXIT_COLLAPSE_DELAY);
      s.tint.to(0, RETURN_SPRING, now, EXIT_DROP_DELAY);
      s.drop.to(0, RETURN_SPRING, now, EXIT_DROP_DELAY);
    }
    s.drag.to(0, DRAG_SPRING, now);
    run();
  }, [run]);

  const hold = useCallback((ms: number) => {
    clearHold();
    holdTimer.current = window.setTimeout(leave, ms);
  }, [leave]);

  const enter = useCallback(() => {
    const s = springs.current;
    for (const spring of [s.drop, s.tint, s.expand, s.reveal, s.drag]) spring.set(0);
    const now = performance.now();
    if (reducedMotion()) {
      // no fall and no spread: the card fades in where it rests
      s.drop.set(1); s.expand.set(1); s.tint.set(1);
      s.reveal.to(1, FADE_SPRING, now);
    } else {
      s.drop.to(1, DROP_SPRING, now);
      s.tint.to(1, TINT_SPRING, now, ENTER_TINT_DELAY);
      s.expand.to(1, EXPAND_SPRING, now, ENTER_EXPAND_DELAY);
      s.reveal.to(1, REVEAL_SPRING, now, ENTER_REVEAL_DELAY);
    }
    paint();
    run();
    hold(ENTER_REVEAL_DELAY + DROPLET_HOLD_MS);
  }, [hold, paint, run]);

  settle.current = () => {
    const next = pending.current;
    pending.current = null;
    phaseRef.current = "in";
    setPhase("in");
    setCurrent(next);
  };

  useEffect(() => onDroplet((notice) => {
    if (!currentRef.current) {
      setCurrent(notice);
      return;
    }
    // one at a time: the newest waits for the current one to fold away
    pending.current = notice;
    leave();
  }), [leave]);

  // each notice starts its fall once its shapes are in the page
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
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // a right-click ends in no click: holding for it would leave the card up for good
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
    dragging.current = true;
    // up follows the finger, down only gives a little
    springs.current.drag.set(Math.max(-120, Math.min(24, dy < 0 ? dy : dy * 0.35)));
    paint();
  };
  const endPress = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const p = press.current;
    if (!p || p.id !== event.pointerId) return;
    press.current = null;
    dragging.current = false;
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
  const box = layout;
  const inset = GOO_BLUR * GOO_INSET_RATIO;
  return (
    <div className="droplet" role="status" aria-live="polite" data-phase={phase} data-kind={current.kind} key={current.id}>
      <div ref={probe} className="droplet-probe" aria-hidden="true" />
      {box && <>
        <svg className="droplet-canvas" width={box.width} height={box.canvasHeight} viewBox={`0 0 ${box.width} ${box.canvasHeight}`} aria-hidden="true" focusable="false">
          <defs>
            <filter id="droplet-goo" x="-50%" y="-200%" width="200%" height="500%" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation={GOO_BLUR} />
              <feColorMatrix mode="matrix" values={gooMatrix()} />
            </filter>
            <filter id="droplet-shadow" x="-50%" y="-100%" width="200%" height="300%">
              <feDropShadow dx="0" dy={SHADOW_DY} stdDeviation={SHADOW_BLUR / 2} style={{ floodColor: "var(--droplet-shadow)" }} />
            </filter>
          </defs>
          <rect ref={shadowEl} className="droplet-shadow" filter="url(#droplet-shadow)" />
          <g filter="url(#droplet-goo)">
            <rect className="droplet-island" x={box.centerX - box.islandWidth / 2 + inset} y={box.islandTop + inset}
              width={box.islandWidth - inset * 2} height={box.islandHeight - inset * 2} rx={Math.max(box.islandRadius - inset, 0)} />
            <rect ref={neckEl} className="droplet-island" />
            <rect ref={dropEl} />
          </g>
        </svg>
        <button
          ref={cardEl}
          type="button"
          className="droplet-card"
          style={{ top: box.cardTop, left: box.cardLeft, width: box.cardWidth, height: box.cardHeight, borderRadius: box.cardRadius }}
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
            <span className="droplet-mark">{current.agent ? <AgentMark agent={current.agent} size={26} /> : null}</span>
            <span className="droplet-text">
              <span className="droplet-title">{current.title}</span>
              <span className="droplet-detail">{detail}</span>
            </span>
            <span className="droplet-dot" aria-hidden="true" />
          </span>
        </button>
      </>}
    </div>
  );
}
