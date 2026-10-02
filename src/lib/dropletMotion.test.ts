import { describe, expect, it } from "bun:test";
import { DROP_SPRING, EXPAND_SPRING, GOO_BLUR_MAX, Spring, dropletGeometry, dropletLayout, neckProfile, tintColor } from "./dropletMotion.ts";

describe("droplet layout", () => {
  it("hangs the card under the safe area and hides the island above the screen, blur and all", () => {
    const phone = dropletLayout(390, 59);
    expect(phone.cardTop).toBe(71);
    expect(phone.cardWidth).toBe(358);
    expect(phone.cardLeft).toBe(16);
    expect(phone.islandBottom).toBeLessThanOrEqual(-(GOO_BLUR_MAX + 2));
    const desktop = dropletLayout(1280, 0);
    expect(desktop.cardTop).toBe(12);
    expect(desktop.cardWidth).toBe(396);
    expect(desktop.centerX).toBe(640);
  });
});

describe("droplet geometry", () => {
  const layout = dropletLayout(390, 0);
  it("starts as nothing at the island and ends as the card", () => {
    const start = dropletGeometry(0, 0, layout);
    expect(start.width).toBe(0);
    expect(start.height).toBe(0);
    const end = dropletGeometry(1, 1, layout);
    expect(end.x).toBeCloseTo(layout.cardLeft);
    expect(end.y).toBeCloseTo(layout.cardTop);
    expect(end.width).toBeCloseTo(layout.cardWidth);
    expect(end.height).toBeCloseTo(layout.cardHeight);
    expect(end.radius).toBeCloseTo(layout.cardRadius);
    expect(end.neckWidth).toBe(0);
    expect(end.offsetY).toBeCloseTo(0);
  });
  it("stretches the falling drop on its neck, which breaks before it lands", () => {
    const falling = dropletGeometry(0.45, 0, layout);
    expect(falling.height).toBeGreaterThan(falling.width);
    expect(falling.neckWidth).toBeGreaterThan(0);
    expect(dropletGeometry(0.9, 0, layout).neckWidth).toBe(0);
    expect(neckProfile(0)).toBe(0);
    expect(neckProfile(1)).toBe(0);
    expect(neckProfile(1.6 / 3)).toBeCloseTo(1);
  });
  it("turns from island black to card white", () => {
    expect(tintColor(0, [0, 0, 0], [255, 255, 255])).toBe("rgb(0, 0, 0)");
    expect(tintColor(1, [0, 0, 0], [255, 255, 255])).toBe("rgb(255, 255, 255)");
  });
});

describe("spring", () => {
  const run = (config: typeof DROP_SPRING, until: number): { values: number[]; spring: Spring } => {
    const spring = new Spring(0);
    spring.to(1, config, 0);
    const values: number[] = [];
    for (let t = 16; t <= until; t += 16) { spring.step(t - 16, t); values.push(spring.value); }
    return { values, spring };
  };
  it("overshoots as an underdamped spring does, and settles in about its duration", () => {
    const { values } = run(EXPAND_SPRING, 1_600);
    expect(Math.max(...values)).toBeGreaterThan(1.005);
    expect(Math.abs(values.at(-1)! - 1)).toBeLessThan(0.002);
    expect(Math.abs(values[Math.round(EXPAND_SPRING.duration / 16)]! - 1)).toBeLessThan(0.03);
  });
  it("waits out its delay, then rests exactly at its target", () => {
    const spring = new Spring(0);
    spring.to(1, DROP_SPRING, 0, 300);
    spring.step(0, 250);
    expect(spring.value).toBe(0);
    let t = 250;
    while (spring.step(t, t + 16)) t += 16;
    expect(spring.value).toBe(1);
  });
});
