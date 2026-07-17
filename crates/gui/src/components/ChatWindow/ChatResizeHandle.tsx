import {
  MIN_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  RESIZE_STEP,
} from "../../hooks/useChatPanelLayout";

interface ChatResizeHandleProps {
  renderedPanelWidth: number;
  isResizing: boolean;
  startResizeDrag: () => void;
  resizePanel: (nextWidth: number) => void;
}

/** Left-edge drag handle for a right-anchored panel. */
export function ChatResizeHandle({
  renderedPanelWidth,
  isResizing,
  startResizeDrag,
  resizePanel,
}: ChatResizeHandleProps) {
  return (
    <div
      className="hc-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={renderedPanelWidth}
      aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={MAX_PANEL_WIDTH}
      tabIndex={0}
      data-resizing={isResizing || undefined}
      data-testid="chat-resize-handle"
      onMouseDown={(event) => {
        event.preventDefault();
        startResizeDrag();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          resizePanel(renderedPanelWidth + RESIZE_STEP);
        } else if (event.key === "ArrowRight") {
          resizePanel(renderedPanelWidth - RESIZE_STEP);
        }
      }}
    />
  );
}
