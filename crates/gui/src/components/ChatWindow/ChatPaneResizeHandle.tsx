import { useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { MIN_SPLIT_PANE_WIDTH } from "../../hooks/useChatPaneManagement";

interface Props {
  leftWidth: number;
  rightWidth: number;
  label: string;
  controls: string;
  /** Retire the gesture when the pane configuration or measured space changes. */
  layoutKey: string;
  onResize: (delta: number) => void;
}

export function ChatPaneResizeHandle({
  leftWidth,
  rightWidth,
  label,
  controls,
  layoutKey,
  onResize,
}: Props) {
  const cleanupRef = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => () => cleanupRef.current?.(), [layoutKey]);

  const min = MIN_SPLIT_PANE_WIDTH;
  const max = leftWidth + rightWidth - min;
  const roundedLeftWidth = Math.round(leftWidth);
  const valueText = `${roundedLeftWidth}px; arrow keys adjust by 16px`;

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false || cleanupRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const bodyStyle = document.body.style;

    // WKWebView still requires the prefixed property on supported macOS
    // versions. Preserve both spellings and their inline priorities.
    const styleNames = ["cursor", "user-select", "-webkit-user-select"];
    const previousStyles = styleNames.map((name) => {
      const value = bodyStyle.getPropertyValue(name);
      const priority = bodyStyle.getPropertyPriority(name);

      return { name, value, priority };
    });

    // Snapshot the adjacent allocation at gesture start, avoiding cumulative drift.
    const resize = onResize;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;

      moveEvent.preventDefault();

      const delta = moveEvent.clientX - startX;
      resize(delta);
    };

    const endPointer = (endEvent: PointerEvent) => {
      if (endEvent.pointerId === pointerId) end();
    };

    const end = () => {
      cleanupRef.current = null;

      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", endPointer);
      document.removeEventListener("pointercancel", endPointer);
      target.removeEventListener("lostpointercapture", endPointer);
      window.removeEventListener("blur", end);

      if (target.hasPointerCapture?.(pointerId)) {
        target.releasePointerCapture(pointerId);
      }

      for (const { name, value, priority } of previousStyles) {
        if (value) bodyStyle.setProperty(name, value, priority);
        else bodyStyle.removeProperty(name);
      }

      setDragging(false);
    };

    cleanupRef.current = end;

    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", endPointer);
    document.addEventListener("pointercancel", endPointer);
    target.addEventListener("lostpointercapture", endPointer);
    window.addEventListener("blur", end);
    target.setPointerCapture?.(pointerId);

    bodyStyle.setProperty("cursor", "ew-resize");
    bodyStyle.setProperty("user-select", "none");
    bodyStyle.setProperty("-webkit-user-select", "none");

    setDragging(true);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let delta: number;

    switch (event.key) {
      case "ArrowLeft":
        delta = -16;
        break;
      case "ArrowRight":
        delta = 16;
        break;
      case "Home":
        delta = min - leftWidth;
        break;
      case "End":
        delta = max - leftWidth;
        break;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (!cleanupRef.current) onResize(delta);
  };

  return (
    <div
      className="hc-pane-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={leftWidth}
      aria-valuetext={valueText}
      tabIndex={0}
      data-resizing={dragging || undefined}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  );
}
