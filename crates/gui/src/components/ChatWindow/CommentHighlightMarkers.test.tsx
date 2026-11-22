import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { CommentHighlightMarkers } from "./CommentHighlightMarkers";
import { useCommentHover } from "./useCommentHover";

/*
 * jsdom has no layout, so quotes are stand-in ranges with fixed line rects:
 * the response rail sits at x=100, the viewport at (0, 0), and comment "a"
 * quotes x 160–260 on the line y 40–60.
 */
const RAIL = 100;
const LINE = { top: 40, bottom: 60, left: 160, right: 260 };

function rect({ top, bottom, left, right }: typeof LINE): DOMRect {
  return {
    top,
    bottom,
    left,
    right,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

function fakeRange(node: Node, lines: (typeof LINE)[]): Range {
  return {
    startContainer: node,
    getClientRects: () => lines.map(rect),
  } as unknown as Range;
}

function Pane({
  enabled = true,
  activeId = null,
  onOpen = () => {},
}: {
  enabled?: boolean;
  activeId?: string | null;
  onOpen?: (id: string) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const rangesRef = useRef<ReadonlyMap<string, Range>>(new Map());
  const hovered = useCommentHover(viewportRef, rangesRef, enabled);
  return (
    <div
      ref={(element) => {
        viewportRef.current = element;
        const text = element?.querySelector("p")?.firstChild;
        if (text && !rangesRef.current.size)
          rangesRef.current = new Map([["a", fakeRange(text, [LINE])]]);
      }}
      data-testid="viewport"
    >
      <div data-local-chat-assistant-response-id="r1">
        <p>quoted text</p>
      </div>
      <output data-testid="hovered">{hovered ?? ""}</output>
      <CommentHighlightMarkers
        viewportRef={viewportRef}
        rangesRef={rangesRef}
        hoveredId={hovered}
        activeId={activeId}
        numbers={new Map([["a", 3]])}
        revision={0}
        onOpen={onOpen}
      />
    </div>
  );
}

function pointAt(target: Element, x: number, y: number) {
  const event = new MouseEvent("pointermove", {
    bubbles: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  act(() => {
    target.dispatchEvent(event);
    vi.runOnlyPendingTimers();
  });
}

const hovered = () => screen.getByTestId("hovered").textContent;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const left = this.matches("[data-local-chat-assistant-response-id]")
        ? RAIL
        : 0;
      return rect({ top: 0, bottom: 600, left, right: 800 });
    }
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("comment hover", () => {
  it("hovers the quote under the pointer and clears off it", () => {
    render(<Pane />);
    const viewport = screen.getByTestId("viewport");
    pointAt(viewport, 200, 50);
    expect(hovered()).toBe("a");
    pointAt(viewport, 200, 90);
    expect(hovered()).toBe("");
  });

  it("keeps the hover along the quoted line toward the rail marker", () => {
    render(<Pane />);
    const viewport = screen.getByTestId("viewport");
    pointAt(viewport, 200, 50);
    // Unquoted text on the same line, between the rail and the quote.
    pointAt(viewport, 120, 50);
    expect(hovered()).toBe("a");
    // Just left of the rail, where the marker straddles it.
    pointAt(viewport, RAIL - 8, 50);
    expect(hovered()).toBe("a");
    // Too far left, or off the quoted line.
    pointAt(viewport, RAIL - 30, 50);
    expect(hovered()).toBe("");
  });

  it("does not start a hover from the corridor alone", () => {
    render(<Pane />);
    pointAt(screen.getByTestId("viewport"), 120, 50);
    expect(hovered()).toBe("");
  });

  it("keeps the hover on the marker and clears when the pointer leaves", () => {
    render(<Pane />);
    const viewport = screen.getByTestId("viewport");
    pointAt(viewport, 200, 50);
    act(() => vi.runOnlyPendingTimers());
    pointAt(screen.getByTestId("comment-hover-marker"), 0, 0);
    expect(hovered()).toBe("a");
    act(() => {
      fireEvent.pointerLeave(viewport);
    });
    expect(hovered()).toBe("");
  });

  it("is off when disabled", () => {
    render(<Pane enabled={false} />);
    pointAt(screen.getByTestId("viewport"), 200, 50);
    expect(hovered()).toBe("");
  });
});

describe("comment highlight markers", () => {
  it("puts the numbered marker on the rail, centred on the first quoted line", () => {
    const onOpen = vi.fn();
    render(<Pane onOpen={onOpen} />);
    pointAt(screen.getByTestId("viewport"), 200, 50);
    act(() => vi.runOnlyPendingTimers());

    const marker = screen.getByRole("button", { name: "Open comment 3" });
    expect(marker.style.left).toBe(`${RAIL}px`);
    expect(marker.style.top).toBe(`${(LINE.top + LINE.bottom) / 2}px`);
    expect(marker.tabIndex).toBe(-1);
    expect(marker.textContent).toBe("3");
    fireEvent.click(marker);
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("draws the focus bar on the rail over the quote's lines", () => {
    render(<Pane activeId="a" />);
    act(() => vi.runOnlyPendingTimers());

    const bar = screen.getByTestId("comment-focus-bar");
    expect(bar.style.left).toBe(`${RAIL}px`);
    expect(bar.style.top).toBe(`${LINE.top}px`);
    expect(bar.style.height).toBe(`${LINE.bottom - LINE.top}px`);
    expect(screen.queryByTestId("comment-hover-marker")).toBeNull();
  });

  it("draws nothing without an active or hovered comment", () => {
    render(<Pane />);
    act(() => vi.runOnlyPendingTimers());
    expect(screen.queryByTestId("comment-focus-bar")).toBeNull();
    expect(screen.queryByTestId("comment-hover-marker")).toBeNull();
  });
});
