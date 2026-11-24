import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { DiagramFrame } from "./DiagramFrame";
import {
  MAX_DIAGRAM_HEIGHT,
  MIN_DIAGRAM_HEIGHT,
  resetDiagramSizes,
  useDiagramBox,
} from "./diagramBox";

// Geometry: a 1232px transcript with 16px padding (1200px of content) and
// a 820px prose measure starting 184px into it; a 300px-tall diagram body.
const PANE_WIDTH = 1232;
const SLOT_LEFT = 200;
const INLINE = 820;
const FULL = 1200;
const BODY_HEIGHT = 300;

const rect = (left: number, width: number, height: number) =>
  ({
    left,
    width,
    height,
    top: 0,
    right: left + width,
    bottom: height,
    x: left,
    y: 0,
    toJSON() {},
  }) as DOMRect;

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
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.hasAttribute("data-transcript-viewport"))
        return rect(0, PANE_WIDTH, 800);
      if (this.classList.contains("diagram-block-slot"))
        return rect(SLOT_LEFT, INLINE, 400);
      if (this.classList.contains("diagram-block-body"))
        return rect(
          SLOT_LEFT,
          INLINE,
          this.style.height ? parseFloat(this.style.height) : BODY_HEIGHT
        );
      return rect(0, 0, 0);
    }
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-transcript-viewport") ? PANE_WIDTH : 0;
    }
  );
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  resetDiagramSizes();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Stands in for a diagram: shows the box it was given and takes focus. */
function Probe({ ownsEscape = false }: { ownsEscape?: boolean }) {
  const box = useDiagramBox();
  return (
    <>
      <button
        type="button"
        data-testid="probe"
        data-fill={String(box?.fill)}
        data-widened={String(box?.widened)}
        data-max-zoom={box?.maxFitZoom}
        onKeyDown={(event: KeyboardEvent) => {
          if (ownsEscape && event.key === "Escape") event.preventDefault();
        }}
      >
        Diagram control
      </button>
      <input aria-label="Diagram search" />
    </>
  );
}

function Frame({
  source = "a -> b",
  label = "Flow",
  ownsEscape = false,
}: {
  source?: string;
  label?: string;
  ownsEscape?: boolean;
}) {
  return (
    <DiagramFrame label={label} language="flow" source={source}>
      <Probe ownsEscape={ownsEscape} />
    </DiagramFrame>
  );
}

function renderFrame(props: Parameters<typeof Frame>[0] = {}) {
  return render(
    <div
      data-transcript-viewport=""
      style={{ paddingLeft: "16px", paddingRight: "16px" }}
    >
      <Frame {...props} />
    </div>
  );
}

const block = (name = "Flow diagram") => screen.getByRole("region", { name });
const widthHandle = () =>
  screen.getByRole("separator", { name: "Flow diagram width" });
const heightHandle = () =>
  screen.getByRole("separator", { name: "Flow diagram height" });
const body = () =>
  block().querySelector<HTMLElement>(".diagram-block-body") as HTMLElement;
const probe = () => screen.getByTestId("probe");
const openButton = () =>
  screen.getByRole("button", { name: "Open Flow diagram in cinema mode" });
const fullWidthButton = () =>
  screen.getByRole("button", { name: "Flow diagram: full pane width" });

function drag(
  el: Element,
  from: { x: number; y: number },
  to: { x: number; y: number }
) {
  fireEvent.pointerDown(el, {
    button: 0,
    pointerId: 1,
    clientX: from.x,
    clientY: from.y,
  });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: to.x, clientY: to.y });
}

describe("DiagramFrame in-place resize", () => {
  it("widens from the right edge on both sides, clamped to the chat pane", () => {
    renderFrame();
    expect(widthHandle()).toHaveAttribute("aria-valuenow", String(INLINE));
    expect(widthHandle()).toHaveAttribute("aria-valuemin", String(INLINE));
    expect(widthHandle()).toHaveAttribute("aria-valuemax", String(FULL));

    // The edge follows the pointer: 100px right is 200px wider, 100px a side.
    drag(widthHandle(), { x: 1000, y: 0 }, { x: 1100, y: 0 });
    expect(block().style.width).toBe("1020px");
    expect(block().style.marginLeft).toBe("-100px");
    expect(widthHandle()).toHaveAttribute("aria-valuenow", "1020");
    expect(probe()).toHaveAttribute("data-widened", "true");

    // At a pane edge it grows toward the other side, never past the pane.
    drag(widthHandle(), { x: 1100, y: 0 }, { x: 3000, y: 0 });
    expect(block().style.width).toBe(`${FULL}px`);
    expect(block().style.marginLeft).toBe("-184px");

    // Narrower than the prose measure is the inline width.
    drag(widthHandle(), { x: 1100, y: 0 }, { x: -2000, y: 0 });
    expect(block().style.width).toBe("");
    expect(block().style.marginLeft).toBe("");
    expect(probe()).toHaveAttribute("data-widened", "false");
  });

  it("makes the box taller or shorter from the bottom edge within bounds", () => {
    renderFrame();
    expect(probe()).toHaveAttribute("data-fill", "false");

    drag(heightHandle(), { x: 0, y: 500 }, { x: 0, y: 600 });
    expect(body().style.height).toBe("400px");
    expect(heightHandle()).toHaveAttribute("aria-valuenow", "400");
    // A box with a height is filled; the diagram rescales to it.
    expect(probe()).toHaveAttribute("data-fill", "true");

    drag(heightHandle(), { x: 0, y: 600 }, { x: 0, y: -5000 });
    expect(body().style.height).toBe(`${MIN_DIAGRAM_HEIGHT}px`);
    drag(heightHandle(), { x: 0, y: 0 }, { x: 0, y: 9000 });
    expect(body().style.height).toBe(`${MAX_DIAGRAM_HEIGHT}px`);
  });

  it("resizes both axes from the corner", () => {
    renderFrame();
    const corner = screen.getByTestId("diagram-block-corner-handle");
    drag(corner, { x: 1000, y: 500 }, { x: 1050, y: 560 });
    expect(block().style.width).toBe("920px");
    expect(block().style.marginLeft).toBe("-50px");
    expect(body().style.height).toBe("360px");
  });

  it("resizes the width from the keyboard, with large steps, full width and reset", () => {
    renderFrame();
    const handle = widthHandle();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(block().style.width).toBe("844px");
    expect(block().style.marginLeft).toBe("-12px");
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(block().style.width).toBe("940px");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(block().style.width).toBe("916px");
    fireEvent.keyDown(handle, { key: "End" });
    expect(block().style.width).toBe(`${FULL}px`);
    expect(fullWidthButton()).toHaveAttribute("aria-pressed", "true");
    // Max clamps further growth.
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(block().style.width).toBe(`${FULL}px`);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(block().style.width).toBe("");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(block().style.width).toBe("");
    // Min clamps further shrinking.
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(block().style.width).toBe("");
  });

  it("resizes the height from the keyboard, with large steps, bounds and reset", () => {
    renderFrame();
    const handle = heightHandle();
    expect(handle).toHaveAttribute("aria-valuenow", String(BODY_HEIGHT));
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(body().style.height).toBe("324px");
    fireEvent.keyDown(handle, { key: "ArrowUp", shiftKey: true });
    expect(body().style.height).toBe("228px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(body().style.height).toBe(`${MIN_DIAGRAM_HEIGHT}px`);
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(body().style.height).toBe(`${MIN_DIAGRAM_HEIGHT}px`);
    fireEvent.keyDown(handle, { key: "End" });
    expect(body().style.height).toBe(`${MAX_DIAGRAM_HEIGHT}px`);
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(body().style.height).toBe(`${MAX_DIAGRAM_HEIGHT}px`);
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(body().style.height).toBe("");
    expect(probe()).toHaveAttribute("data-fill", "false");
  });

  it("snaps to the full pane width and back, and resets the size", () => {
    renderFrame();
    expect(
      screen.queryByRole("button", { name: "Reset Flow diagram size" })
    ).toBeNull();
    fireEvent.click(fullWidthButton());
    expect(block().style.width).toBe(`${FULL}px`);
    expect(fullWidthButton()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(fullWidthButton());
    expect(block().style.width).toBe("");
    expect(fullWidthButton()).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(fullWidthButton());
    fireEvent.keyDown(heightHandle(), { key: "ArrowDown" });
    fireEvent.click(
      screen.getByRole("button", { name: "Reset Flow diagram size" })
    );
    expect(block().style.width).toBe("");
    expect(body().style.height).toBe("");
    expect(
      screen.queryByRole("button", { name: "Reset Flow diagram size" })
    ).toBeNull();
  });

  it("keeps the chosen size across re-renders and remounts of the same block", () => {
    const view = renderFrame();
    fireEvent.click(fullWidthButton());
    fireEvent.keyDown(heightHandle(), { key: "ArrowDown" });

    const wrap = (props: Parameters<typeof Frame>[0]) => (
      <div
        data-transcript-viewport=""
        style={{ paddingLeft: "16px", paddingRight: "16px" }}
      >
        <Frame {...props} />
      </div>
    );
    view.rerender(wrap({}));
    expect(block().style.width).toBe(`${FULL}px`);
    expect(body().style.height).toBe("324px");

    // Streaming replaces the reply's markdown: the block remounts.
    view.unmount();
    renderFrame();
    expect(block().style.width).toBe(`${FULL}px`);
    expect(body().style.height).toBe("324px");
    cleanup();

    // A different diagram starts at its default size.
    renderFrame({ source: "c -> d" });
    expect(block().style.width).toBe("");
    expect(body().style.height).toBe("");
  });

  it("offers no width controls without room to widen", () => {
    render(<Frame />);
    expect(
      screen.queryByRole("separator", { name: "Flow diagram width" })
    ).toBeNull();
    expect(fullWidthButton()).toBeDisabled();
    expect(heightHandle()).toBeInTheDocument();
  });
});

describe("DiagramFrame cinema mode", () => {
  const dialog = () =>
    screen.getByRole("dialog", { name: "Flow diagram, cinema mode" });

  it("opens over the app with the diagram filling it, and Esc returns focus to the trigger", () => {
    const view = renderFrame();
    openButton().focus();
    fireEvent.click(openButton());

    expect(within(dialog()).getByTestId("probe")).toBe(probe());
    expect(probe()).toHaveAttribute("data-fill", "true");
    expect(probe()).toHaveAttribute("data-max-zoom", "2");
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(probe()).toHaveFocus();
    // The transcript keeps the block's place and is inert behind the window.
    expect(
      screen.getByText("Flow is open in cinema mode.")
    ).toBeInTheDocument();
    expect(body().style.height).toBe(`${BODY_HEIGHT}px`);
    expect(view.container).toHaveAttribute("inert");

    fireEvent.keyDown(probe(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.container).not.toHaveAttribute("inert");
    expect(within(block()).getByTestId("probe")).toBe(probe());
    expect(probe()).toHaveAttribute("data-fill", "false");
    expect(openButton()).toHaveFocus();
  });

  it("leaves Esc to a diagram that uses it", () => {
    renderFrame({ ownsEscape: true });
    fireEvent.click(openButton());
    fireEvent.keyDown(probe(), { key: "Escape" });
    expect(dialog()).toBeInTheDocument();
  });

  it("closes from the close control and from the scrim", () => {
    renderFrame();
    fireEvent.click(openButton());
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "Close cinema mode" })
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(openButton()).toHaveFocus();

    fireEvent.click(openButton());
    fireEvent.click(screen.getByTestId("diagram-cinema-scrim"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(openButton()).toHaveFocus();
  });

  it("opens with F from a focused block, but not while typing", () => {
    renderFrame();
    fireEvent.keyDown(screen.getByLabelText("Diagram search"), { key: "f" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(probe(), { key: "f", metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(probe(), { key: "f" });
    expect(dialog()).toBeInTheDocument();
    expect(openButton()).toHaveAttribute("aria-keyshortcuts", "F");
  });

  it("traps focus inside the window", () => {
    renderFrame();
    fireEvent.click(openButton());
    const inset = within(dialog()).getByRole("button", {
      name: "Inset cinema window",
    });
    const closeButton = within(dialog()).getByRole("button", {
      name: "Close cinema mode",
    });
    const search = screen.getByLabelText("Diagram search");

    // Order: window controls, then the diagram.
    search.focus();
    fireEvent.keyDown(search, { key: "Tab" });
    expect(inset).toHaveFocus();
    fireEvent.keyDown(inset, { key: "Tab" });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(closeButton, { key: "Tab" });
    expect(probe()).toHaveFocus();
    fireEvent.keyDown(probe(), { key: "Tab", shiftKey: true });
    expect(closeButton).toHaveFocus();
    inset.focus();
    fireEvent.keyDown(inset, { key: "Tab", shiftKey: true });
    expect(search).toHaveFocus();
  });

  it("toggles between filling the window and an inset window", () => {
    renderFrame();
    fireEvent.click(openButton());
    const cinema = screen.getByTestId("diagram-cinema");
    const toggle = within(dialog()).getByRole("button", {
      name: "Inset cinema window",
    });
    expect(cinema).not.toHaveAttribute("data-inset");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(cinema).toHaveAttribute("data-inset");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(cinema).not.toHaveAttribute("data-inset");
  });

  it("keeps only one cinema window open", () => {
    render(
      <div data-transcript-viewport="">
        <Frame label="Flow" />
        <Frame label="Statechart" source="other" />
      </div>
    );
    fireEvent.click(openButton());
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Statechart diagram in cinema mode",
      })
    );
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveAccessibleName("Statechart diagram, cinema mode");
  });
});
