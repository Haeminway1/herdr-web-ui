import { describe, expect, it } from "bun:test";
import { DYNAMIC_ISLAND_TOP, GROW_SPRING, ISLAND_HEIGHT, ISLAND_WIDTH, Spring, islandLayout, islandShape } from "./dropletMotion.ts";

describe("island layout", () => {
  it("grows out of a Dynamic Island, or from a pill under the safe area elsewhere", () => {
    const island = islandLayout(393, 59, 0, 0, true);
    expect(island.top).toBe(DYNAMIC_ISLAND_TOP);
    expect(island.overIsland).toBe(true);
    expect(island.expandedWidth).toBe(369);
    const notch = islandLayout(390, 47);
    expect(notch.top).toBe(59);
    expect(notch.overIsland).toBe(false);
    expect(islandLayout(1280, 0).expandedWidth).toBe(400);
  });
});

describe("island shape", () => {
  const layout = islandLayout(393, 59, 0, 0, true);
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
  it("fades a pill in and out where there is no island under it", () => {
    const pill = islandLayout(390, 47);
    expect(islandShape(0, pill).opacity).toBe(0);
    expect(islandShape(0.5, pill).opacity).toBe(1);
    expect(islandShape(0, layout).opacity).toBe(1);
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

describe("the camera under a phone's own island", () => {
  it("keeps the content below the camera and the banner tall enough for it", () => {
    const island = islandLayout(393, 59, 0, 0, true);
    expect(island.contentTop).toBeGreaterThanOrEqual(ISLAND_HEIGHT - 4);
    expect(island.expandedHeight - island.contentTop).toBeGreaterThanOrEqual(60);
    expect(islandLayout(390, 47).contentTop).toBe(0);
  });
});
