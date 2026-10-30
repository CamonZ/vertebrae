import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
