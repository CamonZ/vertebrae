import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GapCursor } from "../../thread/toolChange/diffCursor";
import { GAP_CURSOR_ATTRIBUTE } from "./useChangeGaps";
import {
  changesCursorScrollBehavior,
  useChangesCursorOverlay,
} from "./useChangesCursorOverlay";

function prefersReducedMotion(reduce: boolean) {
  vi.mocked(window.matchMedia).mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query === "(prefers-reduced-motion: reduce)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList
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

describe("useChangesCursorOverlay", () => {
  const rect = (element: Element, top: number, height = 20) =>
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: top, width: 400, height })
    );

  it("places the gap bar in the overlay's coordinates, below a status line", async () => {
    prefersReducedMotion(true);
    const container = document.createElement("div");
    const item = document.createElement("div");
    const root = item.attachShadow({ mode: "open" });
    root.innerHTML = `<div data-code data-additions><div data-gutter><div ${GAP_CURSOR_ATTRIBUTE}></div></div></div>`;
    document.body.append(container, item);
    // The overlay starts at the host's top; the scroller sits 22px lower.
    rect(container, 122, 578);
    rect(item, 122, 300);
    rect(root.querySelector(`[${GAP_CURSOR_ATTRIBUTE}]`)!, 222, 30);
    const view = {
      getInstance: () => ({
        getRenderedItems: () => [{ id: "a.rs", type: "diff", element: item }],
      }),
    };
    const gap: GapCursor = { kind: "gap", path: "a.rs", gap: 0, arrival: 1, side: "additions" };
    const overlay = document.createElement("div");
    overlay.append(document.createElement("span"), document.createElement("span"));
    document.body.append(overlay);
    rect(overlay, 100, 600);

    renderHook(() => {
      const hook = useChangesCursorOverlay(
        { current: view } as never,
        { current: container },
        null,
        gap
      );
      hook.overlayRef.current = overlay;
      return hook;
    });
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));

    const bar = overlay.children[0] as HTMLElement;
    expect(bar.hidden).toBe(false);
    // 222 - 100: the separator's offset within the overlay, not the scroller.
    expect(bar.style.transform).toBe("translate3d(0px, 122px, 0) scaleY(30)");
    overlay.remove();
    container.remove();
    item.remove();
  });
});
