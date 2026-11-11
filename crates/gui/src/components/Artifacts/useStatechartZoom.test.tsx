import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useStatechartViewport } from "./useStatechartViewport";
import { useStatechartZoom } from "./useStatechartZoom";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Fixture({ ready = true }: { ready?: boolean }) {
  const viewport = useStatechartViewport();
  const zoom = useStatechartZoom(viewport.canvasRef, ready);
  return (
    <>
      {ready && (
        <span
          data-testid="canvas"
          ref={viewport.canvasRef}
          {...viewport.panHandlers}
        >
          <svg
            ref={zoom.diagramRef}
            data-testid="diagram"
            data-zoom={zoom.zoom}
            style={{
              transform: `translate(${viewport.pan.x + zoom.x}px, ${viewport.pan.y + zoom.y}px)`,
            }}
          />
        </span>
      )}
      <button onClick={() => zoom.setZoom(1, true)}>Reset</button>
      <button onClick={() => zoom.setZoom((value) => value * 1.25)}>
        Zoom in
      </button>
    </>
  );
}

function geometry() {
  const canvas = screen.getByTestId("canvas");
  const diagram = screen.getByTestId("diagram");
  Object.defineProperty(canvas, "clientHeight", { value: 400 });
  const measureDiagram = vi.spyOn(diagram, "getBoundingClientRect");

  measureDiagram.mockImplementation(() => {
    const coordinates = diagram.style.transform.match(
      /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g
    )!;
    const [x, y] = coordinates.map(Number);

    return {
      left: 108 + x - canvas.scrollLeft,
      top: 208 + y - canvas.scrollTop,
    } as DOMRect;
  });

  const point = () => {
    const bounds = diagram.getBoundingClientRect();
    const zoom = Number(diagram.dataset.zoom);
    return [(380 - bounds.left) / zoom, (450 - bounds.top) / zoom];
  };

  const wheel = (deltaY: number, deltaMode = 0, ctrlKey = true) => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey,
      deltaY,
      deltaMode,
      clientX: 380,
      clientY: 450,
    });
    fireEvent(canvas, event);
    return event;
  };

  return { canvas, diagram, point, wheel };
}

it("anchors rapid input after scrolling, including scroll clamping at the canvas edge", () => {
  render(<Fixture />);

  const { canvas, diagram, point, wheel } = geometry();
  canvas.scrollLeft = 170;
  canvas.scrollTop = 220;

  const before = point();
  act(() => {
    for (let i = 0; i < 60; i++) wheel(-0.5);
  });

  const rapidInputZoom = Number(diagram.dataset.zoom);

  const expectedRapidZoom = Math.exp(0.06);

  expect(rapidInputZoom).toBeCloseTo(expectedRapidZoom);

  const rapidInputX = point()[0];

  expect(rapidInputX).toBeCloseTo(before[0]);

  const rapidInputY = point()[1];

  expect(rapidInputY).toBeCloseTo(before[1]);
  act(() => {
    wheel(100);
    canvas.scrollLeft = 0;
    canvas.scrollTop = 0;
  });

  const clampedX = point()[0];

  expect(clampedX).toBeCloseTo(before[0]);

  const clampedY = point()[1];

  expect(clampedY).toBeCloseTo(before[1]);
});

it.each([
  [16, 0],
  [1, 1],
  [0.04, 2],
])("normalizes wheel delta %s in mode %s", (delta, mode) => {
  render(<Fixture />);

  const { diagram, wheel } = geometry();

  const normalizedWheelPrevented = wheel(delta, mode).defaultPrevented;

  expect(normalizedWheelPrevented).toBe(true);

  const normalizedZoom = Number(diagram.dataset.zoom);

  const expectedNormalizedZoom = Math.exp(-0.032);

  expect(normalizedZoom).toBeCloseTo(expectedNormalizedZoom);
});

it("preserves ordinary and outside scrolling, clamps both limits, and retains buttons", () => {
  render(<Fixture />);

  const { diagram, wheel } = geometry();

  const ordinaryWheelPrevented = wheel(100, 0, false).defaultPrevented;

  expect(ordinaryWheelPrevented).toBe(false);

  const outside = new WheelEvent("wheel", {
    ctrlKey: true,
    cancelable: true,
    deltaY: 100,
  });
  fireEvent(document.body, outside);

  expect(outside.defaultPrevented).toBe(false);

  const initialZoom = Number(diagram.dataset.zoom);

  expect(initialZoom).toBe(1);
  for (let i = 0; i < 20; i++) wheel(-10000);

  const maximumZoom = Number(diagram.dataset.zoom);

  expect(maximumZoom).toBe(3);
  for (let i = 0; i < 20; i++) wheel(10000);

  const minimumZoom = Number(diagram.dataset.zoom);

  expect(minimumZoom).toBe(0.05);

  const resetButton = screen.getByText("Reset");

  fireEvent.click(resetButton);

  expect(diagram.style.transform).toBe("translate(0px, 0px)");

  const zoomButton = screen.getByText("Zoom in");

  fireEvent.click(zoomButton);

  const buttonZoom = Number(diagram.dataset.zoom);

  expect(buttonZoom).toBe(1.25);
});

it("handles WebKit cumulative pinch scales and prevents duplicate wheel zoom", () => {
  render(<Fixture />);

  const { canvas, diagram, point, wheel } = geometry();

  const before = point();

  function gesture(type: string, scale: number) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { scale, clientX: 380, clientY: 450 });
    fireEvent(canvas, event);
    return event;
  }

  const orphanGesturePrevented = gesture("gesturechange", 2).defaultPrevented;

  expect(orphanGesturePrevented).toBe(false);

  const gestureStartPrevented = gesture("gesturestart", 1).defaultPrevented;

  expect(gestureStartPrevented).toBe(true);
  gesture("gesturechange", 1.5);
  wheel(-100);
  gesture("gesturechange", 2);

  const expandedZoom = Number(diagram.dataset.zoom);

  expect(expandedZoom).toBe(2);
  gesture("gesturechange", 0.75);
  gesture("gestureend", 0.75);

  const contractedZoom = Number(diagram.dataset.zoom);

  expect(contractedZoom).toBe(0.75);

  const pinchX = point()[0];

  expect(pinchX).toBeCloseTo(before[0]);

  const pinchY = point()[1];

  expect(pinchY).toBeCloseTo(before[1]);
  wheel(100);

  const wheelZoomAfterPinch = Number(diagram.dataset.zoom);

  expect(wheelZoomAfterPinch).toBeLessThan(0.75);
});

it("attaches after loading and cleans up under Strict Mode and remounts", () => {
  const ui = render(
    <StrictMode>
      <Fixture ready={false} />
    </StrictMode>
  );
  ui.rerender(
    <StrictMode>
      <Fixture />
    </StrictMode>
  );

  const { canvas, diagram, wheel } = geometry();
  wheel(-100);

  const mountedZoom = Number(diagram.dataset.zoom);

  const expectedMountedZoom = Math.exp(0.2);

  expect(mountedZoom).toBeCloseTo(expectedMountedZoom);
  ui.unmount();

  const event = new WheelEvent("wheel", {
    ctrlKey: true,
    cancelable: true,
    deltaY: 100,
  });
  fireEvent(canvas, event);

  expect(event.defaultPrevented).toBe(false);
  render(
    <StrictMode>
      <Fixture />
    </StrictMode>
  );

  const remounted = geometry();
  remounted.wheel(-100);

  const remountedZoom = Number(remounted.diagram.dataset.zoom);

  expect(remountedZoom).toBeCloseTo(expectedMountedZoom);
});

it("keeps the pointer anchor after drag-pan and preserves selection suppression", () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId = 1;
      isPrimary = true;
    }
  );

  render(<Fixture />);

  const { canvas, point, wheel } = geometry();
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn(() => true);
  canvas.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(canvas, { clientX: 200, clientY: 200 });

  fireEvent.pointerMove(canvas, { clientX: 120, clientY: 160 });

  fireEvent.pointerUp(canvas);

  const draggedTransform = screen.getByTestId("diagram").style.transform;

  expect(draggedTransform).toBe("translate(-80px, -40px)");
  canvas.scrollLeft = 50;

  const before = point();
  wheel(-120);

  const draggedZoomX = point()[0];

  expect(draggedZoomX).toBeCloseTo(before[0]);

  const draggedZoomY = point()[1];

  expect(draggedZoomY).toBeCloseTo(before[1]);

  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  fireEvent(canvas, click);

  expect(click.defaultPrevented).toBe(true);
});
