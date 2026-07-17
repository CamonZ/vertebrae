import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatResizeHandle } from "./ChatResizeHandle";

describe("ChatResizeHandle", () => {
  it("renders with the chat-resize-handle testid", () => {
    render(
      <ChatResizeHandle
        renderedPanelWidth={400}
        isResizing={false}
        startResizeDrag={vi.fn()}
        resizePanel={vi.fn()}
      />
    );
    expect(screen.getByTestId("chat-resize-handle")).toBeInTheDocument();
  });

  it("renders with role=separator and vertical orientation", () => {
    render(
      <ChatResizeHandle
        renderedPanelWidth={400}
        isResizing={false}
        startResizeDrag={vi.fn()}
        resizePanel={vi.fn()}
      />
    );
    const handle = screen.getByRole("separator");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
  });

  it("shows the current width via aria-valuenow", () => {
    render(
      <ChatResizeHandle
        renderedPanelWidth={450}
        isResizing={false}
        startResizeDrag={vi.fn()}
        resizePanel={vi.fn()}
      />
    );
    expect(screen.getByTestId("chat-resize-handle")).toHaveAttribute(
      "aria-valuenow",
      "450"
    );
  });

  it("fires startResizeDrag on mouse down", () => {
    const startResizeDrag = vi.fn();
    render(
      <ChatResizeHandle
        renderedPanelWidth={400}
        isResizing={false}
        startResizeDrag={startResizeDrag}
        resizePanel={vi.fn()}
      />
    );
    fireEvent.mouseDown(screen.getByTestId("chat-resize-handle"));
    expect(startResizeDrag).toHaveBeenCalledTimes(1);
  });

  it("increases width on ArrowLeft keydown", () => {
    const resizePanel = vi.fn();
    render(
      <ChatResizeHandle
        renderedPanelWidth={400}
        isResizing={false}
        startResizeDrag={vi.fn()}
        resizePanel={resizePanel}
      />
    );
    fireEvent.keyDown(screen.getByTestId("chat-resize-handle"), {
      key: "ArrowLeft",
    });
    expect(resizePanel).toHaveBeenCalledWith(416);
  });

  it("decreases width on ArrowRight keydown", () => {
    const resizePanel = vi.fn();
    render(
      <ChatResizeHandle
        renderedPanelWidth={400}
        isResizing={false}
        startResizeDrag={vi.fn()}
        resizePanel={resizePanel}
      />
    );
    fireEvent.keyDown(screen.getByTestId("chat-resize-handle"), {
      key: "ArrowRight",
    });
    expect(resizePanel).toHaveBeenCalledWith(384);
  });

  it("does not call resizePanel for other keys", () => {
    const resizePanel = vi.fn();
    render(
      <ChatResizeHandle
        renderedPanelWidth={400}
        isResizing={false}
        startResizeDrag={vi.fn()}
        resizePanel={resizePanel}
      />
    );
    fireEvent.keyDown(screen.getByTestId("chat-resize-handle"), {
      key: "Enter",
    });
    expect(resizePanel).not.toHaveBeenCalled();
  });

  it("reflects the resizing state via data-resizing", () => {
    render(
      <ChatResizeHandle
        renderedPanelWidth={400}
        isResizing={true}
        startResizeDrag={vi.fn()}
        resizePanel={vi.fn()}
      />
    );
    expect(screen.getByTestId("chat-resize-handle")).toHaveAttribute(
      "data-resizing"
    );
  });

  it("omits data-resizing when not resizing", () => {
    render(
      <ChatResizeHandle
        renderedPanelWidth={400}
        isResizing={false}
        startResizeDrag={vi.fn()}
        resizePanel={vi.fn()}
      />
    );
    expect(screen.getByTestId("chat-resize-handle")).not.toHaveAttribute(
      "data-resizing"
    );
  });
});
