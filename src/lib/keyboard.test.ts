import { describe, expect, test } from "bun:test";
import { DISMISS_DRAG_PX, dragDismisses, tapDismisses } from "./keyboard.ts";

describe("dragDismisses", () => {
  test("a drag down the transcript puts the keyboard away", () => {
    expect(dragDismisses(0, DISMISS_DRAG_PX)).toBe(true);
    expect(dragDismisses(10, 80)).toBe(true);
  });

  test("a short, upward or sideways drag leaves it up", () => {
    expect(dragDismisses(0, DISMISS_DRAG_PX - 1)).toBe(false);
    expect(dragDismisses(0, -80)).toBe(false);
    expect(dragDismisses(90, 40)).toBe(false);
  });
});

describe("tapDismisses", () => {
  test("a tap with no element or on plain transcript reads", () => {
    expect(tapDismisses(null, "")).toBe(true);
  });

  test("a tap that ends a text selection keeps the keyboard", () => {
    expect(tapDismisses(null, "copied words")).toBe(false);
  });
});
