/**
 * The in-app alert's motion (components/Droplet.tsx), ported from expo-dynamic-notifications
 * (rit3zh, MIT; THIRD_PARTY_NOTICES.md): its layout, its drop, neck and card geometry, and its
 * springs, drawn here with SVG and requestAnimationFrame instead of Skia and Reanimated.
 *
 * Four values drive it, each on a spring from 0 to 1: `drop` (the drop grows out of an island
 * above the screen and falls to the card's centre, stretched while its neck holds), `tint`
 * (island black to card white on the way), `expand` (the drop spreads into the card) and
 * `reveal` (the card's text).
 */

export const ISLAND_WIDTH = 126;
export const ISLAND_HEIGHT = 37.33;
export const CARD_MAX_WIDTH = 396;
export const CARD_HEIGHT = 74;
export const CARD_MARGIN = 16;
export const CARD_GAP = 34;
export const DROP_SIZE = 52;
export const NECK_WIDTH = 60;
export const CANVAS_PADDING = 96;
export const EDGE_MARGIN = 10;
export const GOO_BLUR_MAX = 20;
/** GOO_BLUR_MIN..GOO_BLUR_MAX at the original's GOO_STRENGTH 0.62 */
export const GOO_BLUR = 5 + (GOO_BLUR_MAX - 5) * 0.62;
export const GOO_GAIN = 22;
export const GOO_THRESHOLD = 0.43;
export const GOO_INSET_RATIO = 0.26;
const DROP_GROW_SPAN = 0.7;
const DROP_GROW_POWER = 1.25;
const DROP_STRETCH = 0.38;
const NECK_BREAK = 0.82;
const NECK_RISE = 1.6;
const NECK_FALL = 1.4;
const DROP_TINT_START = 0.06;
const DROP_TINT_END = 0.88;
const CONTENT_MIN_SCALE = 0.88;
export const SHADOW_DY = 10;
export const SHADOW_BLUR = 14;
export const ENTER_TINT_DELAY = 110;
export const ENTER_EXPAND_DELAY = 340;
export const ENTER_REVEAL_DELAY = 560;
export const EXIT_COLLAPSE_DELAY = 100;
export const EXIT_DROP_DELAY = 280;
/** the card's gap under the top of what can be seen (Triad's top-edge anchor) */
export const TOP_SPACING = 12;

export interface SpringConfig {
  duration: number;
  dampingRatio: number;
  /** a starting push, in units per second, in the direction it heads */
  velocity?: number;
}
export const DROP_SPRING: SpringConfig = { duration: 1150, dampingRatio: 0.82 };
export const EXPAND_SPRING: SpringConfig = { duration: 1000, dampingRatio: 0.8 };
export const REVEAL_SPRING: SpringConfig = { duration: 700, dampingRatio: 1 };
export const TINT_SPRING: SpringConfig = { duration: 700, dampingRatio: 1 };
export const COLLAPSE_SPRING: SpringConfig = { duration: 660, dampingRatio: 0.92, velocity: 2 };
export const RETURN_SPRING: SpringConfig = { duration: 1150, dampingRatio: 0.9 };
export const FADE_SPRING: SpringConfig = { duration: 360, dampingRatio: 1 };
export const DRAG_SPRING: SpringConfig = { duration: 560, dampingRatio: 0.7 };

export interface DropletLayout {
  width: number;
  centerX: number;
  islandWidth: number;
  islandHeight: number;
  islandTop: number;
  islandBottom: number;
  islandRadius: number;
  cardWidth: number;
  cardHeight: number;
  cardRadius: number;
  cardTop: number;
  cardLeft: number;
  cardCenterY: number;
  canvasHeight: number;
}

/**
 * The card hangs TOP_SPACING under the safe area's top. The island it falls from sits above the
 * screen, far enough that neither it nor its blur shows at rest: the drop grows out of the top
 * edge itself. No device is guessed: an island, a notch and a desktop window differ only in
 * `insetTop`.
 */
export function dropletLayout(width: number, insetTop: number, insetLeft = 0, insetRight = 0): DropletLayout {
  const cardTop = insetTop + TOP_SPACING;
  const islandBottom = Math.min(cardTop - CARD_GAP, -(GOO_BLUR_MAX + 2));
  const safeWidth = Math.max(width - insetLeft - insetRight, 0);
  const centerX = insetLeft + safeWidth / 2;
  const cardWidth = Math.max(Math.min(safeWidth - CARD_MARGIN * 2, CARD_MAX_WIDTH), 0);
  return {
    width,
    centerX,
    islandWidth: ISLAND_WIDTH,
    islandHeight: ISLAND_HEIGHT,
    islandTop: islandBottom - ISLAND_HEIGHT,
    islandBottom,
    islandRadius: ISLAND_HEIGHT / 2,
    cardWidth,
    cardHeight: CARD_HEIGHT,
    cardRadius: CARD_HEIGHT / 2,
    cardTop,
    cardLeft: centerX - cardWidth / 2,
    cardCenterY: cardTop + CARD_HEIGHT / 2,
    canvasHeight: cardTop + CARD_HEIGHT + CANVAS_PADDING,
  };
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
const mix = (t: number, from: number, to: number): number => from + (to - from) * t;
const easeOutPower = (t: number, power: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), power);

/** The neck's width over the fall: it rises, peaks, and is gone once the drop is NECK_BREAK of the way. */
export function neckProfile(progress: number, rise = NECK_RISE, fall = NECK_FALL): number {
  const t = clamp(progress, 0, 1);
  if (t <= 0 || t >= 1) return 0;
  const peak = rise / (rise + fall);
  const normal = Math.pow(peak, rise) * Math.pow(1 - peak, fall);
  return (Math.pow(t, rise) * Math.pow(1 - t, fall)) / normal;
}

export interface DropletGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  neckX: number;
  neckY: number;
  neckWidth: number;
  neckHeight: number;
  shadowOpacity: number;
  /** the body's centre below the card's resting centre: the text rides it */
  offsetY: number;
  widthRatio: number;
}

export function dropletGeometry(drop: number, expand: number, layout: DropletLayout): DropletGeometry {
  const grow = easeOutPower(clamp(drop / DROP_GROW_SPAN, 0, 1), DROP_GROW_POWER);
  const neck = neckProfile(drop / NECK_BREAK);
  const stretch = 1 + DROP_STRETCH * neck;
  const droplet = DROP_SIZE * grow;
  const width = Math.max(Math.min(mix(expand, droplet / stretch, layout.cardWidth), layout.width - EDGE_MARGIN * 2), 0);
  const height = Math.max(mix(expand, droplet * stretch, layout.cardHeight), 0);
  const radius = Math.min(mix(expand, droplet * 0.5, layout.cardRadius), Math.min(width, height) / 2);
  const originY = layout.islandBottom - layout.islandHeight * 0.34;
  const centerY = mix(drop, originY, layout.cardCenterY);
  const neckWidth = Math.min(NECK_WIDTH, width) * neck;
  const neckY = layout.islandBottom - layout.islandHeight * 0.5;
  return {
    x: layout.centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    radius: Math.max(radius, 0),
    neckX: layout.centerX - neckWidth / 2,
    neckY,
    neckWidth,
    neckHeight: Math.max(centerY - neckY, 0),
    shadowOpacity: clamp(expand, 0, 1),
    offsetY: centerY - layout.cardCenterY,
    widthRatio: layout.cardWidth > 0 ? width / layout.cardWidth : 0,
  };
}

/** The text at a reveal: it fades, sharpens and grows in, a little past full while the card overshoots. */
export function contentStyle(reveal: number, geometry: DropletGeometry): { opacity: number; scale: number; blur: number } {
  const progress = clamp(reveal, 0, 1);
  const overshoot = clamp(geometry.widthRatio - 1, 0, 0.2);
  return { opacity: progress, scale: mix(progress, CONTENT_MIN_SCALE, 1) + overshoot * progress, blur: 8 * (1 - progress) };
}

export type Rgb = readonly [number, number, number];

/** The drop's colour: island black to card white over DROP_TINT_START..END of `tint`. */
export function tintColor(tint: number, from: Rgb, to: Rgb): string {
  const t = clamp((tint - DROP_TINT_START) / (DROP_TINT_END - DROP_TINT_START), 0, 1);
  const channel = (i: 0 | 1 | 2): number => Math.round(mix(t, from[i], to[i]));
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

/** The feColorMatrix of the goo: alpha sharpened back into an edge, so shapes that blur into each other read as one liquid. */
export function gooMatrix(gain = GOO_GAIN, threshold = GOO_THRESHOLD): string {
  return `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${gain} ${-gain * threshold}`;
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
  private push = 0;

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
    this.push = config.velocity ?? 0;
  }

  set(value: number): void {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.push = 0;
  }

  /** Advances from `then` to `now` in steps of at most 4ms; true while it still moves. */
  step(then: number, now: number): boolean {
    if (now <= this.startAt) return this.value !== this.target || this.push !== 0;
    let t = Math.max(then, this.startAt);
    if (this.push !== 0) {
      this.velocity += this.push * Math.sign(this.target - this.value || 1);
      this.push = 0;
    }
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
