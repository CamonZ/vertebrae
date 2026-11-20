import { afterEach, describe, expect, it, vi } from "vitest";
import { changesCursorScrollBehavior } from "./useChangesCursorOverlay";

function prefersReducedMotion(reduce: boolean) {
  vi.mocked(window.matchMedia).mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query === "(prefers-reduced-motion: reduce)",
        media: query,
      }) as MediaQueryList
  );
}

describe("changesCursorScrollBehavior", () => {
  afterEach(() => prefersReducedMotion(false));

  it("smooth-follows a deliberate move", () => {
    prefersReducedMotion(false);
    expect(changesCursorScrollBehavior(Infinity)).toBe("smooth");
    expect(changesCursorScrollBehavior(400)).toBe("smooth");
  });

  it("jumps while the arrow key repeats", () => {
    prefersReducedMotion(false);
    expect(changesCursorScrollBehavior(33)).toBe("instant");
  });

  it("never animates under reduced motion", () => {
    prefersReducedMotion(true);
    expect(changesCursorScrollBehavior(Infinity)).toBe("instant");
  });
});
