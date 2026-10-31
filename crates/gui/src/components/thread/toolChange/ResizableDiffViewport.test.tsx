import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FAR_VIEWPORT_MARGIN_PX,
  NEAR_VIEWPORT_DWELL_MS,
} from "../../../hooks/useNearViewport";
import {
  DEFAULT_DIFF_HEIGHT,
  MIN_DIFF_HEIGHT,
  ResizableDiffViewport,
} from "./ResizableDiffViewport";

function setup() {
  render(
    <ResizableDiffViewport>
      <span>diff body</span>
    </ResizableDiffViewport>
  );
  const viewport = screen.getByTestId("diff-viewport");
  const handle = screen.getByRole("separator", { name: "Resize diff" });
  return { viewport, handle };
}

type Observer = { callback: IntersectionObserverCallback; margin: number };

/** Report the viewport as intersecting (or not) one observer margin. */
function stubObservers() {
  const observers: Observer[] = [];
  const resizes: ResizeObserverCallback[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(
        callback: IntersectionObserverCallback,
        options: IntersectionObserverInit
      ) {
        observers.push({
          callback,
          margin: parseInt(options.rootMargin ?? "0", 10),
        });
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizes.push(callback);
      }
      observe() {}
      disconnect() {}
    }
  );
  const fire = (target: Element, isIntersecting: boolean, far = false) =>
    act(() =>
      observers
        .filter((o) => (o.margin === FAR_VIEWPORT_MARGIN_PX) === far)
        .forEach((o) =>
          o.callback(
            [
              { target, isIntersecting },
            ] as unknown as IntersectionObserverEntry[],
            {} as IntersectionObserver
          )
        )
    );
  const resize = () =>
    act(() => resizes.forEach((r) => r([], {} as ResizeObserver)));
  return { fire, resize };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ResizableDiffViewport", () => {
  it("caps content at the default height and scrolls inside", () => {
    const { viewport, handle } = setup();
    expect(screen.getByText("diff body")).toBeTruthy();
    expect(viewport.style.maxHeight).toBe(`${DEFAULT_DIFF_HEIGHT}px`);
    expect(viewport.className).toContain("evdiff-scroll");
    expect(handle).toHaveAttribute(
      "aria-valuenow",
      String(DEFAULT_DIFF_HEIGHT)
    );
  });

  it("resizes from the rendered height while dragging the handle", () => {
    const { viewport, handle } = setup();
    viewport.getBoundingClientRect = () => ({ height: 200 }) as DOMRect;

    fireEvent.pointerDown(handle, { button: 0, clientY: 100, pointerId: 1 });
    expect(handle).toHaveAttribute("data-resizing");
    fireEvent.pointerMove(handle, { clientY: 250, pointerId: 1 });
    expect(viewport.style.maxHeight).toBe("350px");
    fireEvent.pointerMove(handle, { clientY: -500, pointerId: 1 });
    expect(viewport.style.maxHeight).toBe(`${MIN_DIFF_HEIGHT}px`);
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(handle).not.toHaveAttribute("data-resizing");

    fireEvent.pointerMove(handle, { clientY: 900, pointerId: 1 });
    expect(viewport.style.maxHeight).toBe(`${MIN_DIFF_HEIGHT}px`);
  });

  it("resizes with the arrow keys", () => {
    const { viewport, handle } = setup();
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(viewport.style.maxHeight).toBe(`${DEFAULT_DIFF_HEIGHT + 24}px`);
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(viewport.style.maxHeight).toBe(`${DEFAULT_DIFF_HEIGHT - 24}px`);
  });

  it("renders the placeholder far from view and keeps the rendered height", () => {
    const { fire, resize } = stubObservers();
    vi.useFakeTimers();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      top: 50_000,
      bottom: 50_100,
      height: 212,
    } as DOMRect);
    render(
      <ResizableDiffViewport
        placeholder={(limit) => <span>plain patch {limit}</span>}
      >
        <span>diff body</span>
      </ResizableDiffViewport>
    );
    const viewport = screen.getByTestId("diff-viewport");
    expect(screen.getByText(`plain patch ${DEFAULT_DIFF_HEIGHT}`)).toBeTruthy();
    expect(screen.queryByText("diff body")).toBeNull();
    expect(viewport.style.height).toBe("");

    fire(viewport, true);
    act(() => vi.advanceTimersByTime(NEAR_VIEWPORT_DWELL_MS));
    expect(screen.getByText("diff body")).toBeTruthy();
    resize();

    fire(viewport, false, true);
    expect(screen.getByText(`plain patch ${DEFAULT_DIFF_HEIGHT}`)).toBeTruthy();
    expect(viewport.style.height).toBe("212px");
  });

  it("always renders children without a placeholder", () => {
    stubObservers();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      top: 50_000,
      bottom: 50_100,
    } as DOMRect);
    setup();
    expect(screen.getByText("diff body")).toBeTruthy();
  });
});
