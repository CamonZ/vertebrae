import { StrictMode, useState } from "react";
import { createPortal } from "react-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { MachineDiagramViewport, ZOOM_GUTTER } from "../MachineDiagramViewport";
import { FlowScene } from "./FlowDiagram";
import { useLaidOutFlow } from "./useLaidOutFlow";

let size = { width: 900, height: 600 };
const observers = new Set<() => void>();
let disconnected = 0;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => size.width
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    () => size.height
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe() {
        observers.add(this.callback);
      }
      disconnect() {
        observers.delete(this.callback);
        disconnected++;
      }
    }
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observers.clear();
});

const input = {
  version: 1,
  parts: [
    { id: "source", kind: "source" },
    { id: "worker", kind: "worker" },
  ],
  rails: [{ id: "job", from: "source.out", to: "worker.in", label: "job" }],
};

function AsyncHost() {
  const state = useLaidOutFlow(input);
  const [overlay, setOverlay] = useState<HTMLElement | null>(null);
  const diagram =
    state.status === "done" && state.result.ok
      ? state.result.flow.arrangements[0]
      : null;
  return (
    <>
      <output>{state.status}</output>
      <MachineDiagramViewport
        mode="full-page"
        width={diagram?.width ?? 0}
        height={diagram?.height ?? 0}
        ready={!!diagram}
        fitOnMount
        overlayRef={setOverlay}
        resizeLabel="Resize diagram"
      >
        {diagram && <FlowScene diagram={diagram} t={0} />}
      </MachineDiagramViewport>
      {overlay &&
        createPortal(
          <button style={{ pointerEvents: "auto" }}>Overlay action</button>,
          overlay
        )}
    </>
  );
}

const stage = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".md-stage")!;

test("real async compiler/layout host fits, isolates overlay input and remounts under StrictMode without workers", async () => {
  // jsdom has no Worker: exercise the shipped client's fallback, not a mock layout.
  expect(typeof Worker).toBe("undefined");
  const run = async () => {
    const view = render(
      <StrictMode>
        <AsyncHost />
      </StrictMode>
    );
    expect(screen.getByText("pending")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("done")).toBeInTheDocument());
    const svg = screen.getByRole("group", { name: /flow/ });
    const width = Number(svg.getAttribute("width"));
    const height = Number(svg.getAttribute("height"));
    expect(Number(stage(view.container).dataset.zoom)).toBeCloseTo(
      Math.max(0.1, Math.min(1, (900 - ZOOM_GUTTER) / width, 600 / height))
    );
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByTestId("machine-diagram-viewport").style.height).toBe(
      "100%"
    );
    const before = stage(view.container).style.transform;
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Overlay action" }),
      { button: 0, clientX: 10, clientY: 10 }
    );
    fireEvent.pointerMove(
      screen.getByRole("button", { name: "Overlay action" }),
      { clientX: 90, clientY: 80 }
    );
    fireEvent.wheel(screen.getByRole("button", { name: "Overlay action" }), {
      ctrlKey: true,
      deltaY: -100,
    });
    expect(stage(view.container).style.transform).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(stage(view.container).style.transform).not.toBe(before);
    view.unmount();
    expect(observers.size).toBe(0);
  };
  await run();
  await run();
  expect(disconnected).toBeGreaterThanOrEqual(4);
});

test("camera model: delayed visibility/geometry, count updates, resize and explicit fit", () =>
  hegel.test(
    (tc) => {
      size = {
        width: tc.draw(gs.integers({ minValue: 200, maxValue: 1600 })),
        height: tc.draw(gs.integers({ minValue: 200, maxValue: 1000 })),
      };
      const width = tc.draw(gs.integers({ minValue: 400, maxValue: 3000 }));
      const height = tc.draw(gs.integers({ minValue: 300, maxValue: 1800 }));
      const draw = (ready: boolean, count: number) => (
        <MachineDiagramViewport
          width={width}
          height={height}
          mode="full-page"
          fitOnMount
          ready={ready}
        >
          <span>{count}</span>
        </MachineDiagramViewport>
      );
      const view = render(draw(false, 0));
      try {
        expect(stage(view.container).dataset.zoom).toBe("1");
        view.rerender(draw(true, 0));
        const expected = Math.max(
          0.1,
          Math.min(1, (size.width - ZOOM_GUTTER) / width, size.height / height)
        );
        expect(Number(stage(view.container).dataset.zoom)).toBeCloseTo(
          expected
        );
        fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
        const camera = stage(view.container).style.transform;
        view.rerender(
          draw(true, tc.draw(gs.integers({ minValue: 1, maxValue: 10000 })))
        );
        size = { width: 700, height: 450 };
        act(() => observers.forEach((notify) => notify()));
        expect(stage(view.container).style.transform).toBe(camera);
        fireEvent.click(screen.getByRole("button", { name: "Fit to view" }));
        expect(Number(stage(view.container).dataset.zoom)).toBeCloseTo(
          Math.max(0.05, Math.min(3, (700 - ZOOM_GUTTER) / width, 450 / height))
        );
      } finally {
        view.unmount();
      }
    },
    { testCases: 60 }
  ));

test("a hidden host does not consume its initial fit before becoming measurable", () => {
  size = { width: 0, height: 0 };
  const view = render(
    <MachineDiagramViewport
      mode="full-page"
      width={1200}
      height={800}
      fitOnMount
    >
      scene
    </MachineDiagramViewport>
  );
  expect(stage(view.container).dataset.zoom).toBe("1");
  size = { width: 800, height: 400 };
  act(() => observers.forEach((notify) => notify()));
  expect(stage(view.container).dataset.zoom).toBe("0.5");
});
