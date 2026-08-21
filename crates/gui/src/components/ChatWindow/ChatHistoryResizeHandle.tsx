import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampHistoryWidth,
  HISTORY_RESIZE_STEP,
  MAX_HISTORY_WIDTH,
  MIN_HISTORY_WIDTH,
} from "../../hooks/useChatHistoryPanelLayout";

interface ChatHistoryResizeHandleProps {
  historyWidth: number;
  maxWidth: number;
  onResize: (nextWidth: number) => void;
}

interface DragStart {
  clientX: number;
  width: number;
}

function safeMaxWidth(maxWidth: number): number {
  if (!Number.isFinite(maxWidth)) return MAX_HISTORY_WIDTH;
  return Math.min(MAX_HISTORY_WIDTH, Math.max(MIN_HISTORY_WIDTH, maxWidth));
}

function clampToAvailableWidth(width: number, maxWidth: number): number {
  return Math.min(safeMaxWidth(maxWidth), clampHistoryWidth(width));
}

/** Focusable separator between the maximized history sidebar and chat panes. */
export function ChatHistoryResizeHandle({
  historyWidth,
  maxWidth,
  onResize,
}: ChatHistoryResizeHandleProps) {
  const effectiveMaxWidth = safeMaxWidth(maxWidth);
  const effectiveWidth = clampToAvailableWidth(historyWidth, effectiveMaxWidth);
  const dragStartRef = useRef<DragStart | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const resizeFromDrag = useCallback(
    (clientX: number) => {
      const dragStart = dragStartRef.current;
      if (!dragStart) return;
      onResize(
        clampToAvailableWidth(
          dragStart.width + clientX - dragStart.clientX,
          effectiveMaxWidth
        )
      );
    },
    [effectiveMaxWidth, onResize]
  );

  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (event: MouseEvent) => {
      event.preventDefault();
      resizeFromDrag(event.clientX);
    };
    const onMouseUp = () => {
      dragStartRef.current = null;
      setIsDragging(false);
    };
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [isDragging, resizeFromDrag]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") {
      nextWidth = effectiveWidth - HISTORY_RESIZE_STEP;
    } else if (event.key === "ArrowRight") {
      nextWidth = effectiveWidth + HISTORY_RESIZE_STEP;
    } else if (event.key === "Home") {
      nextWidth = MIN_HISTORY_WIDTH;
    } else if (event.key === "End") {
      nextWidth = effectiveMaxWidth;
    }
    if (nextWidth === null) return;

    event.preventDefault();
    onResize(clampToAvailableWidth(nextWidth, effectiveMaxWidth));
  };

  return (
    <div
      className="hc-history-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat history"
      aria-valuenow={effectiveWidth}
      aria-valuemin={MIN_HISTORY_WIDTH}
      aria-valuemax={effectiveMaxWidth}
      aria-valuetext={`${effectiveWidth}px; arrow keys adjust by ${HISTORY_RESIZE_STEP}px`}
      tabIndex={0}
      data-testid="chat-history-resize-handle"
      data-resizing={isDragging || undefined}
      data-resize-step={HISTORY_RESIZE_STEP}
      style={{ left: `${Math.max(0, effectiveWidth - 4)}px` }}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragStartRef.current = {
          clientX: event.clientX,
          width: effectiveWidth,
        };
        setIsDragging(true);
      }}
      onKeyDown={handleKeyDown}
    />
  );
}
