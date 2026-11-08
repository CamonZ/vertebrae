import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStatechartViewport } from "./useStatechartViewport";

beforeEach(() => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number;
      isPrimary: boolean;

      constructor(type: string, options: PointerEventInit = {}) {
        super(type, options);
        this.pointerId = options.pointerId ?? 1;
        this.isPrimary = options.isPrimary ?? true;
      }
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture() {
  const select = vi.fn();

  function Fixture() {
    const viewport = useStatechartViewport();

    return (
      <div>
        <span
          ref={viewport.containerRef}
          data-testid="container"
          style={{
            width: "90%",
            height: viewport.height,
          }}
        >
          <span
            ref={viewport.canvasRef}
            data-testid="canvas"
            {...viewport.panHandlers}
          >
            <span
              data-testid="world"
              style={{
                transform: `translate(${viewport.pan.x}px, ${viewport.pan.y}px)`,
              }}
            >
              <button onClick={select}>State</button>
            </span>
          </span>
          <button {...viewport.resizeHandlers}>Resize</button>
        </span>
      </div>
    );
  }

  render(<Fixture />);

  const canvas = screen.getByTestId("canvas");
  const resize = screen.getByRole("button", { name: "Resize" });
  const container = screen.getByTestId("container");

  for (const element of [canvas, resize]) {
    element.setPointerCapture = vi.fn();
    element.hasPointerCapture = vi.fn(() => true);
    element.releasePointerCapture = vi.fn();
  }

  vi.spyOn(container, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        width: container.style.width.endsWith("px")
          ? parseFloat(container.style.width)
          : 800,
        height: parseFloat(container.style.height),
      }) as DOMRect
  );
  Object.defineProperty(container.parentElement, "clientWidth", { value: 900 });

  return { canvas, resize, container, select };
}

it("pans both axes, suppresses a dragged state's click, and preserves simple selection", () => {
  const { canvas, select } = fixture();
  const state = screen.getByRole("button", { name: "State" });
  canvas.scrollLeft = 100;
  canvas.scrollTop = 150;

  fireEvent.pointerDown(state, { clientX: 200, clientY: 200 });
  fireEvent.pointerMove(state, { clientX: 160, clientY: 130 });
  fireEvent.pointerUp(canvas);
  fireEvent.click(state);

  expect(screen.getByTestId("world")).toHaveStyle({
    transform: "translate(-40px, -70px)",
  });
  expect(canvas.scrollLeft).toBe(100);
  expect(canvas.scrollTop).toBe(150);
  expect(select).not.toHaveBeenCalled();
  expect(canvas.releasePointerCapture).toHaveBeenCalledWith(1);

  fireEvent.pointerDown(state, { clientX: 100, clientY: 100 });
  fireEvent.pointerMove(state, { clientX: 101, clientY: 101 });
  fireEvent.pointerUp(state);
  fireEvent.click(state);

  expect(select).toHaveBeenCalledOnce();
});

it("ignores other pointers and stops panning on cancellation or loss of capture", () => {
  const { canvas } = fixture();
  canvas.scrollTop = 100;

  fireEvent.pointerDown(canvas, { clientX: 200, clientY: 200 });
  fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 100, clientY: 100 });
  expect(screen.getByTestId("world")).toHaveStyle({
    transform: "translate(0px, 0px)",
  });

  fireEvent.pointerMove(canvas, { clientX: 200, clientY: 150 });
  expect(screen.getByTestId("world")).toHaveStyle({
    transform: "translate(0px, -50px)",
  });

  fireEvent.pointerCancel(canvas);
  fireEvent.pointerMove(canvas, { clientX: 200, clientY: 100 });
  expect(screen.getByTestId("world")).toHaveStyle({
    transform: "translate(0px, -50px)",
  });

  fireEvent.pointerDown(canvas, { clientX: 200, clientY: 200 });
  fireEvent.lostPointerCapture(canvas);
  fireEvent.pointerMove(canvas, { clientX: 100, clientY: 100 });
  expect(screen.getByTestId("world")).toHaveStyle({
    transform: "translate(0px, -50px)",
  });
});

it("resizes height with the diff-style grip, clamps dimensions, and supports arrow keys", () => {
  const { resize, container } = fixture();

  fireEvent.pointerDown(resize, { clientX: 800, clientY: 640 });
  fireEvent.pointerMove(resize, { clientX: 600, clientY: 740 });
  fireEvent.pointerUp(resize);

  expect(container).toHaveStyle({ width: "90%", height: "740px" });
  expect(resize).toHaveFocus();

  fireEvent.keyDown(resize, { key: "ArrowRight" });
  fireEvent.keyDown(resize, { key: "ArrowDown", shiftKey: true });

  expect(container).toHaveStyle({ width: "90%", height: "788px" });

  fireEvent.pointerDown(resize, { clientX: 0, clientY: 0 });
  fireEvent.pointerMove(resize, { clientX: -2000, clientY: -2000 });
  expect(container).toHaveStyle({ width: "90%", height: "320px" });

  fireEvent.pointerMove(resize, { clientX: 2000, clientY: 2000 });
  expect(container).toHaveStyle({ width: "90%", height: "1600px" });
});
