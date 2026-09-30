/*
 * The workspace drawer follows a phone's finger: a swipe in from the left edge opens it,
 * as the menu button does, and a swipe to the left closes it again. Only at the drawer's
 * width (<=768px, styles.css) and only for a mostly horizontal stroke, so the terminal's
 * one-finger scrolling and the transcript's vertical scrolling keep working.
 */

/** A stroke has to start this close to the left edge to open the drawer. */
export const EDGE_PX = 24;
/** How far a finger travels sideways before the drawer opens or closes. */
export const SWIPE_PX = 56;
/** Movement below this is not a direction yet. */
const SLOP_PX = 10;

export type SwipeVerdict = "open" | "close" | "claim" | "pending" | "ignore";

/**
 * What a stroke from (startX) that has moved (dx, dy) means. "claim" is a recognised
 * swipe still short of SWIPE_PX: the caller keeps it from scrolling what lies under it.
 */
export function swipeVerdict(drawerOpen: boolean, startX: number, dx: number, dy: number): SwipeVerdict {
  if (!drawerOpen && startX > EDGE_PX) return "ignore";
  if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return "pending";
  if (Math.abs(dy) >= Math.abs(dx)) return "ignore";
  if (!drawerOpen && dx > 0) return dx >= SWIPE_PX ? "open" : "claim";
  if (drawerOpen && dx < 0) return -dx >= SWIPE_PX ? "close" : "claim";
  return "ignore";
}

/** Listens on the whole document; returns the cleanup. */
export function watchDrawerSwipe(isOpen: () => boolean, setOpen: (open: boolean) => void): () => void {
  const narrow = window.matchMedia("(max-width: 768px)");
  let start: { x: number; y: number; open: boolean } | null = null;
  // a recognised swipe owns the stroke until the finger lifts, after the drawer moved too
  let claimed = false;
  let done = false;
  const onStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    start = event.touches.length === 1 && touch && narrow.matches ? { x: touch.clientX, y: touch.clientY, open: isOpen() } : null;
    claimed = false;
    done = false;
  };
  const onMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (start === null || !touch) return;
    const verdict = done ? "claim" : swipeVerdict(start.open, start.x, touch.clientX - start.x, touch.clientY - start.y);
    if (verdict === "pending") return;
    if (verdict === "ignore") {
      // a stroke that was already the drawer's stays so; one that never was goes back to the page
      if (!claimed) { start = null; return; }
    }
    claimed = true;
    // a recognised swipe belongs to the drawer, not to the terminal or list under the finger
    event.preventDefault();
    event.stopPropagation();
    if (!done && (verdict === "open" || verdict === "close")) {
      setOpen(verdict === "open");
      done = true;
    }
  };
  const onEnd = (): void => { start = null; claimed = false; done = false; };
  document.addEventListener("touchstart", onStart, { capture: true, passive: true });
  document.addEventListener("touchmove", onMove, { capture: true, passive: false });
  document.addEventListener("touchend", onEnd, { capture: true, passive: true });
  document.addEventListener("touchcancel", onEnd, { capture: true, passive: true });
  return () => {
    document.removeEventListener("touchstart", onStart, { capture: true });
    document.removeEventListener("touchmove", onMove, { capture: true });
    document.removeEventListener("touchend", onEnd, { capture: true });
    document.removeEventListener("touchcancel", onEnd, { capture: true });
  };
}
