import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_HISTORY_WIDTH,
  MIN_HISTORY_WIDTH,
} from "../../hooks/useChatHistoryPanelLayout";
import { ChatHistoryResizeHandle } from "./ChatHistoryResizeHandle";

function renderHandle(
  onResize = vi.fn(),
  props: Partial<React.ComponentProps<typeof ChatHistoryResizeHandle>> = {}
) {
  render(
    <ChatHistoryResizeHandle
      historyWidth={300}
      maxWidth={MAX_HISTORY_WIDTH}
      onResize={onResize}
      {...props}
    />
  );
  return screen.getByTestId("chat-history-resize-handle");
}

describe("ChatHistoryResizeHandle", () => {
  it("exposes a focusable vertical separator with current bounds", () => {
    const handle = renderHandle();

    expect(handle).toHaveAttribute("role", "separator");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-label", "Resize chat history");
    expect(handle).toHaveAttribute("aria-valuenow", "300");
    expect(handle).toHaveAttribute("aria-valuemin", "272");
    expect(handle).toHaveAttribute("aria-valuemax", "400");
    expect(handle).toHaveAttribute(
      "aria-valuetext",
      "300px; arrow keys adjust by 16px"
    );
    expect(handle).toHaveAttribute("tabindex", "0");
  });

  it("adjusts by one resize step with keyboard arrows", () => {
    const onResize = vi.fn();
    const handle = renderHandle(onResize);

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });

    expect(onResize).toHaveBeenNthCalledWith(1, 284);
    expect(onResize).toHaveBeenNthCalledWith(2, 316);
  });

  it("uses Home and End to reach the available bounds", () => {
    const onResize = vi.fn();
    const handle = renderHandle(onResize, { maxWidth: 360 });

    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "End" });

    expect(onResize).toHaveBeenNthCalledWith(1, MIN_HISTORY_WIDTH);
    expect(onResize).toHaveBeenNthCalledWith(2, 360);
  });

  it("clamps keyboard adjustments to the available maximum", () => {
    const onResize = vi.fn();
    const handle = renderHandle(onResize, {
      historyWidth: 352,
      maxWidth: 360,
    });

    fireEvent.keyDown(handle, { key: "ArrowRight" });

    expect(onResize).toHaveBeenCalledWith(360);
  });

  it("resizes with mouse movement and cleans up after mouseup", () => {
    const onResize = vi.fn();
    const handle = renderHandle(onResize, { historyWidth: 300 });

    fireEvent.mouseDown(handle, { button: 0, clientX: 100 });
    expect(handle).toHaveAttribute("data-resizing");
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.mouseMove(document, { clientX: 140 });
    expect(onResize).toHaveBeenCalledWith(340);

    fireEvent.mouseUp(document);
    expect(handle).not.toHaveAttribute("data-resizing");
    expect(document.body.style.userSelect).toBe("");

    const callsAfterMouseup = onResize.mock.calls.length;
    fireEvent.mouseMove(document, { clientX: 160 });
    expect(onResize).toHaveBeenCalledTimes(callsAfterMouseup);
  });

  it("clamps a drag outside the panel to the safe maximum", () => {
    const onResize = vi.fn();
    const handle = renderHandle(onResize, { historyWidth: 300 });

    fireEvent.mouseDown(handle, { button: 0, clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 10000 });

    expect(onResize).toHaveBeenLastCalledWith(MAX_HISTORY_WIDTH);
  });

  it("ignores non-left mouse buttons and unrelated keys", () => {
    const onResize = vi.fn();
    const handle = renderHandle(onResize);

    fireEvent.mouseDown(handle, { button: 2, clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 140 });
    fireEvent.keyDown(handle, { key: "Enter" });

    expect(onResize).not.toHaveBeenCalled();
    expect(handle).not.toHaveAttribute("data-resizing");
  });
});
