import { describe, expect, it } from "bun:test";
import { GROW_SPRING, HIDE_SPRING, ISLAND_HEIGHT, ISLAND_WIDTH, REVEAL_DELAY, REVEAL_SPRING, SHRINK_DELAY, SHRINK_SPRING, Spring, islandLayout, islandShape, reducedMotionShape } from "./dropletMotion.ts";

describe("island layout", () => {
  it("keeps the full pill below the native inset and app header", () => {
    const island = islandLayout(393, 59, 0, 0, 105);
    expect(island.top).toBe(117);
    expect(island.top).toBeGreaterThan(59);
    expect(island.expandedWidth).toBe(369);
    expect(island.expandedHeight).toBe(68);
    const notch = islandLayout(390, 47);
    expect(notch.top).toBe(59);
    expect(islandLayout(393, 59, 0, 0, 40).top).toBe(71);
    expect(islandLayout(1280, 0).expandedWidth).toBe(400);
    const landscape = islandLayout(852, 0, 30, 20, 46);
    expect(landscape.centerX).toBe(431);
    expect(landscape.top).toBe(58);
  });
  it("joins the native capsule only in selected portrait geometry and clears the camera for content", () => {
    const layout = islandLayout(393, 59, 0, 0, 105, true);
    expect(layout.top).toBe(11);
    expect(layout.contentTop).toBe(54);
    expect(layout.top + layout.contentTop).toBeGreaterThan(59);
    expect(layout.expandedHeight).toBe(122);
    expect(islandLayout(393, 59, 0, 0, 105).top).toBe(117);
  });
});

describe("island shape", () => {
  const layout = islandLayout(393, 59, 0, 0, 105, true);
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
  it("returns to the same center and top through entry and exit, never leaving a second pill", () => {
    const center = layout.centerX;
    for (const progress of [0, 0.12, 0.4, 0.8, 1, 1.04, 0.8, 0.4, 0.12, 0]) {
      const shape = islandShape(progress, layout);
      expect(shape.top).toBe(11);
      expect(shape.left + shape.width / 2).toBeCloseTo(center);
      expect(shape.left).toBeGreaterThanOrEqual(0);
      expect(shape.left + shape.width).toBeLessThanOrEqual(393);
    }
    expect(islandShape(0, layout).opacity).toBe(0);
    expect(islandShape(1, layout).height).toBeGreaterThan(59 - layout.top + 44);
  });
  it("fades the compact shape in and out in fallback mode", () => {
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
      expect(reducedMotionShape(-0.2, box).opacity).toBe(0);
      expect(reducedMotionShape(1.2, box).opacity).toBe(1);
    }
  });
});

describe("spring", () => {
  it("reveals content after growth and fades it before the shape returns to the same compact anchor", () => {
    const layout = islandLayout(393, 59, 0, 0, 105, true);
    const grow = new Spring(0);
    const reveal = new Spring(0);
    grow.to(1, GROW_SPRING, 0);
    reveal.to(1, REVEAL_SPRING, 0, REVEAL_DELAY);
    let previous = 0;
    for (const time of [0, 80, 160, 240, 520, 900]) {
      grow.step(previous, time);
      reveal.step(previous, time);
      previous = time;
      const shape = islandShape(grow.value, layout);
      expect(shape.top).toBe(11);
      expect(shape.left + shape.width / 2).toBeCloseTo(196.5);
      if (time <= 160) expect(reveal.value).toBe(0);
    }
    grow.set(1);
    reveal.set(1);
    grow.to(0, SHRINK_SPRING, 1_000, SHRINK_DELAY);
    reveal.to(0, HIDE_SPRING, 1_000);
    previous = 1_000;
    for (const time of [1_080, 1_160, 1_240, 1_400, 1_700, 2_000]) {
      grow.step(previous, time);
      reveal.step(previous, time);
      previous = time;
      const shape = islandShape(grow.value, layout);
      expect(shape.top).toBe(11);
      expect(shape.left + shape.width / 2).toBeCloseTo(196.5);
      if (time <= 1_160) expect(shape.width).toBe(layout.expandedWidth);
    }
    expect(reveal.value).toBe(0);
    expect(grow.value).toBe(0);
    expect(islandShape(grow.value, layout).width).toBe(ISLAND_WIDTH);
  });
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
