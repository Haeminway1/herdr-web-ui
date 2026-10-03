import { describe, expect, it } from "bun:test";
import { GROW_SPRING, ISLAND_HEIGHT, ISLAND_WIDTH, Spring, islandLayout, islandShape, reducedMotionShape } from "./dropletMotion.ts";

describe("island layout", () => {
  it("stays below both the camera safe area and the app header", () => {
    expect(islandLayout(393, 59, 0, 0, 105).top).toBe(117);
    expect(islandLayout(393, 59, 0, 0, 46).top).toBe(71);
    expect(islandLayout(852, 0, 59, 59, 46).top).toBe(58);
    expect(islandLayout(393, 59).expandedWidth).toBe(369);
    expect(islandLayout(1280, 0).expandedWidth).toBe(400);
  });
});

describe("island shape", () => {
  const layout = islandLayout(393, 59, 0, 0, 105);
  it("is the compact island at rest and the banner when grown, from the same top", () => {
    const rest = islandShape(0, layout);
    expect(rest.width).toBe(ISLAND_WIDTH);
    expect(rest.height).toBeCloseTo(ISLAND_HEIGHT);
    expect(rest.radius).toBeCloseTo(ISLAND_HEIGHT / 2);
    const grown = islandShape(1, layout);
    expect(grown.width).toBe(layout.expandedWidth);
    expect(grown.height).toBe(layout.expandedHeight);
    expect(grown.top).toBe(rest.top);
    expect(grown.left + grown.width / 2).toBeCloseTo(rest.left + rest.width / 2);
  });
  it("fades the capsule in and out without leaving an idle pill", () => {
    const pill = islandLayout(390, 47);
    expect(islandShape(0, pill).opacity).toBe(0);
    expect(islandShape(0.5, pill).opacity).toBe(1);
    expect(islandShape(0, layout).opacity).toBe(0);
  });
  it("keeps expanded geometry while the whole reduced-motion card fades on either layout", () => {
    for (const box of [layout, islandLayout(390, 47)]) {
      const expanded = islandShape(1, box);
      for (const opacity of [0, 0.25, 0.75, 1]) {
        expect(reducedMotionShape(opacity, box)).toEqual({ ...expanded, opacity });
      }
    }
  });
});

describe("spring", () => {
  it("overshoots as an underdamped spring does, and settles in about its duration", () => {
    const spring = new Spring(0);
    spring.to(1, GROW_SPRING, 0);
    const values: number[] = [];
    for (let t = 16; t <= 1_200; t += 16) { spring.step(t - 16, t); values.push(spring.value); }
    expect(Math.max(...values)).toBeGreaterThan(1.01);
    expect(Math.abs(values[Math.round(GROW_SPRING.duration / 16)]! - 1)).toBeLessThan(0.03);
    expect(Math.abs(values.at(-1)! - 1)).toBeLessThan(0.002);
  });
  it("waits out its delay, then rests exactly at its target", () => {
    const spring = new Spring(0);
    spring.to(1, GROW_SPRING, 0, 300);
    spring.step(0, 250);
    expect(spring.value).toBe(0);
    let t = 250;
    while (spring.step(t, t + 16)) t += 16;
    expect(spring.value).toBe(1);
  });
});
