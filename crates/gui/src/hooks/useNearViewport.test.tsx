import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FAR_VIEWPORT_MARGIN_PX,
  NEAR_VIEWPORT_DWELL_MS,
  NEAR_VIEWPORT_MARGIN_PX,
  useNearViewport,
} from "./useNearViewport";

type Instance = {
  callback: IntersectionObserverCallback;
  margin: number;
  root: Element | Document | null | undefined;
  targets: Set<Element>;
  disconnected: boolean;
};
let instances: Instance[] = [];

function stubIntersectionObserver() {
  instances = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      instance: Instance;
      constructor(
        callback: IntersectionObserverCallback,
        options: IntersectionObserverInit
      ) {
        this.instance = {
          callback,
          margin: parseInt(options.rootMargin ?? "0", 10),
          root: options.root,
          targets: new Set(),
          disconnected: false,
        };
        instances.push(this.instance);
      }
      observe(target: Element) {
        this.instance.targets.add(target);
      }
      unobserve(target: Element) {
        this.instance.targets.delete(target);
      }
      disconnect() {
        this.instance.disconnected = true;
      }
    }
  );
}

function fire(margin: number, isIntersecting: boolean) {
  const instance = instances.find((i) => i.margin === margin)!;
  act(() =>
    instance.callback(
      [...instance.targets].map(
        (target) => ({ target, isIntersecting }) as IntersectionObserverEntry
      ),
      {} as IntersectionObserver
    )
  );
}

function Probe({ top = 0 }: { top?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  return (
    <div style={{ overflowY: "auto" }} data-testid="scroller">
      <div
        ref={(element) => {
          ref.current = element;
          if (element)
            element.getBoundingClientRect = () =>
              ({ top, bottom: top + 100 }) as DOMRect;
        }}
      >
        {near ? "near" : "far"}
      </div>
    </div>
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useNearViewport", () => {
  it("treats every element as near without IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<Probe top={100_000} />);
    expect(screen.getByText("near")).toBeInTheDocument();
  });

  it("measures the initial state against the scroll container before paint", () => {
    stubIntersectionObserver();
    render(<Probe top={100_000} />);
    expect(screen.getByText("far")).toBeInTheDocument();
    expect(instances[0].root).toBe(screen.getByTestId("scroller"));
  });

  it("becomes near after dwelling in the near margin and far only past the far margin", () => {
    vi.useFakeTimers();
    stubIntersectionObserver();
    render(<Probe top={100_000} />);

    fire(NEAR_VIEWPORT_MARGIN_PX, true);
    expect(screen.getByText("far")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(NEAR_VIEWPORT_DWELL_MS));
    expect(screen.getByText("near")).toBeInTheDocument();

    // Leaving the near band but staying inside the far band keeps it near.
    fire(NEAR_VIEWPORT_MARGIN_PX, false);
    fire(FAR_VIEWPORT_MARGIN_PX, true);
    expect(screen.getByText("near")).toBeInTheDocument();

    fire(FAR_VIEWPORT_MARGIN_PX, false);
    expect(screen.getByText("far")).toBeInTheDocument();
  });

  it("stays far when a fling passes through the near margin", () => {
    vi.useFakeTimers();
    stubIntersectionObserver();
    render(<Probe top={100_000} />);

    fire(NEAR_VIEWPORT_MARGIN_PX, true);
    act(() => vi.advanceTimersByTime(NEAR_VIEWPORT_DWELL_MS - 1));
    fire(NEAR_VIEWPORT_MARGIN_PX, false);
    act(() => vi.advanceTimersByTime(NEAR_VIEWPORT_DWELL_MS));
    expect(screen.getByText("far")).toBeInTheDocument();
  });

  it("shares observers per root and disconnects them with the last element", () => {
    stubIntersectionObserver();
    const { unmount } = render(<Probe />);
    expect(screen.getByText("near")).toBeInTheDocument();
    expect(instances).toHaveLength(2);
    unmount();
    expect(instances.every((i) => i.disconnected)).toBe(true);
  });
});
