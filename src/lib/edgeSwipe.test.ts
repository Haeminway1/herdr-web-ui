import { describe, expect, test } from "bun:test";
import { EDGE_PX, SWIPE_PX, swipeVerdict } from "./edgeSwipe.ts";

describe("swipeVerdict", () => {
  test("a swipe in from the left edge opens the closed drawer", () => {
    expect(swipeVerdict(false, 4, 20, 2)).toBe("claim");
    expect(swipeVerdict(false, 4, SWIPE_PX, 5)).toBe("open");
  });

  test("a stroke that starts away from the edge is the page's", () => {
    expect(swipeVerdict(false, EDGE_PX + 1, SWIPE_PX * 2, 0)).toBe("ignore");
  });

  test("a vertical stroke from the edge still scrolls", () => {
    expect(swipeVerdict(false, 4, 12, 40)).toBe("ignore");
  });

  test("a tiny movement is not a direction yet", () => {
    expect(swipeVerdict(false, 4, 3, 2)).toBe("pending");
  });

  test("a swipe to the left anywhere closes the open drawer", () => {
    expect(swipeVerdict(true, 200, -20, 3)).toBe("claim");
    expect(swipeVerdict(true, 200, -SWIPE_PX, 3)).toBe("close");
    expect(swipeVerdict(true, 200, SWIPE_PX, 3)).toBe("ignore");
  });
});
