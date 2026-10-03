/**
 * The phone's in-app alert (components/Droplet.tsx) as the iPhone's Dynamic Island shows one:
 * a compact capsule grows into a rounded banner inside the app, below the phone's safe area and
 * app header. It never draws over the phone's physical camera.
 */

/** the compact island, as an iPhone draws it in portrait */
export const ISLAND_WIDTH = 126;
export const ISLAND_HEIGHT = 37.33;
/** the expanded island: a screen's width less a margin each side, one name and one line under it */
export const EXPANDED_MARGIN = 12;
export const EXPANDED_MAX_WIDTH = 400;
export const EXPANDED_HEIGHT = 68;
export const EXPANDED_RADIUS = 30;
/** gap below the safe area and app header */
export const TOP_SPACING = 12;

export interface SpringConfig {
  duration: number;
  dampingRatio: number;
}
/** a short, restrained expansion with a slight overshoot */
export const GROW_SPRING: SpringConfig = { duration: 400, dampingRatio: 0.8 };
/** its content, once it has room */
export const REVEAL_SPRING: SpringConfig = { duration: 260, dampingRatio: 1 };
export const REVEAL_DELAY = 90;
/** the way out: the content first, then the island back into its pill */
export const HIDE_SPRING: SpringConfig = { duration: 140, dampingRatio: 1 };
export const SHRINK_SPRING: SpringConfig = { duration: 320, dampingRatio: 0.95 };
export const SHRINK_DELAY = 70;
export const DRAG_SPRING: SpringConfig = { duration: 320, dampingRatio: 0.9 };

export interface IslandLayout {
  /** the island's top edge: it grows down and out from here */
  top: number;
  centerX: number;
  compactWidth: number;
  compactHeight: number;
  expandedWidth: number;
  expandedHeight: number;
}

/** Place the in-app capsule below both the hardware safe area and the app header. */
export function islandLayout(width: number, insetTop: number, insetLeft = 0, insetRight = 0, headerBottom = 0): IslandLayout {
  const safeWidth = Math.max(width - insetLeft - insetRight, 0);
  return {
    top: Math.max(insetTop, headerBottom) + TOP_SPACING,
    centerX: insetLeft + safeWidth / 2,
    compactWidth: ISLAND_WIDTH,
    compactHeight: ISLAND_HEIGHT,
    expandedWidth: Math.max(Math.min(safeWidth - EXPANDED_MARGIN * 2, EXPANDED_MAX_WIDTH), ISLAND_WIDTH),
    expandedHeight: EXPANDED_HEIGHT,
  };
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
const mix = (t: number, from: number, to: number): number => from + (to - from) * t;

export interface IslandShape {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
  /** the compact capsule fades in and out instead of lingering at rest */
  opacity: number;
}

/** The island at `grow` (0 compact, 1 expanded; the spring overshoots past 1 and back). */
export function islandShape(grow: number, layout: IslandLayout): IslandShape {
  const width = mix(grow, layout.compactWidth, layout.expandedWidth);
  const height = mix(clamp(grow, 0, 1.08), layout.compactHeight, layout.expandedHeight);
  const radius = Math.min(mix(clamp(grow, 0, 1), layout.compactHeight / 2, EXPANDED_RADIUS), height / 2);
  return {
    left: layout.centerX - width / 2,
    top: layout.top,
    width,
    height,
    radius,
    opacity: clamp(grow * 4, 0, 1),
  };
}

/** Reduced motion keeps the expanded card in place and fades the entire shape. */
export function reducedMotionShape(reveal: number, layout: IslandLayout): IslandShape {
  return { ...islandShape(1, layout), opacity: clamp(reveal, 0, 1) };
}

/** The content at a reveal: it fades and settles in from a little smaller and softer. */
export function contentStyle(reveal: number): { opacity: number; scale: number; blur: number } {
  const progress = clamp(reveal, 0, 1);
  return { opacity: progress, scale: mix(progress, 0.92, 1), blur: 4 * (1 - progress) };
}

/**
 * A damped spring, timed like Reanimated's duration springs: an underdamped one overshoots by
 * its damping ratio, and each settles in about its `duration`.
 */
export class Spring {
  value: number;
  velocity = 0;
  target: number;
  private stiffness = 0;
  private damping = 0;
  private startAt = 0;

  constructor(value: number) {
    this.value = value;
    this.target = value;
  }

  /** Heads for `target` from `now + delay`. */
  to(target: number, config: SpringConfig, now: number, delay = 0): void {
    this.target = target;
    this.startAt = now + delay;
    const seconds = config.duration / 1000;
    const zeta = config.dampingRatio;
    // the envelope's 1% point at the duration
    const omega = zeta < 1 ? 4.6 / (zeta * seconds) : 6.6 / seconds;
    this.stiffness = omega * omega;
    this.damping = 2 * zeta * omega;
  }

  set(value: number): void {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  /** Advances from `then` to `now` in steps of at most 4ms; true while it still moves. */
  step(then: number, now: number): boolean {
    if (now <= this.startAt) return this.value !== this.target;
    let t = Math.max(then, this.startAt);
    while (t < now) {
      const dt = Math.min(4, now - t);
      const seconds = dt / 1000;
      const force = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
      this.velocity += force * seconds;
      this.value += this.velocity * seconds;
      t += dt;
    }
    if (Math.abs(this.value - this.target) < 0.0005 && Math.abs(this.velocity) < 0.005) {
      this.value = this.target;
      this.velocity = 0;
      return false;
    }
    return true;
  }
}
