import {
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

type Gesture = {
  pointerId: number;
  x: number;
  y: number;
  dragged: boolean;
} & (
  | { kind: "pan"; left: number; top: number }
  | { kind: "resize"; height: number }
);

/** Own pointer capture only for an active drag; a click still selects a state. */
export function useStatechartViewport() {
  const containerRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLSpanElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [height, setHeight] = useState(640);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  function resize(nextHeight: number) {
    const availableHeight = Math.min(1600, nextHeight);
    const boundedHeight = Math.max(320, availableHeight);

    setHeight(boundedHeight);
  }

  function startPan(event: PointerEvent<HTMLElement>) {
    const canvas = canvasRef.current;

    if (!canvas || event.button !== 0 || event.isPrimary === false) return;

    suppressClick.current = false;
    gesture.current = {
      kind: "pan",
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: pan.x,
      top: pan.y,
      dragged: false,
    };
  }

  function startResize(event: PointerEvent<HTMLElement>) {
    const bounds = containerRef.current?.getBoundingClientRect();

    if (!bounds || event.button !== 0 || event.isPrimary === false) return;

    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      kind: "resize",
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      height: bounds.height,
      dragged: false,
    };
  }

  function move(event: PointerEvent<HTMLElement>) {
    const active = gesture.current;

    if (!active || active.pointerId !== event.pointerId) return;

    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;

    if (!active.dragged && Math.hypot(dx, dy) < 4) return;

    if (!active.dragged) {
      active.dragged = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }

    event.preventDefault();

    if (active.kind === "resize") {
      resize(active.height + dy);
      return;
    }

    // A fitted chart may have no scrollable overflow. Translation allows
    // free panning in either direction at every zoom level.
    setPan({ x: active.left + dx, y: active.top + dy });

    suppressClick.current = true;
  }

  function end(event: PointerEvent<HTMLElement>) {
    const active = gesture.current;

    if (!active || active.pointerId !== event.pointerId) return;

    gesture.current = null;
    setDragging(false);

    if (event.type === "pointercancel") suppressClick.current = false;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLElement>) {
    const bounds = containerRef.current?.getBoundingClientRect();
    const step = event.shiftKey ? 48 : 24;
    const delta =
      event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : null;

    if (!bounds || delta === null) return;

    event.preventDefault();
    resize(bounds.height + delta);
  }

  const dragHandlers = {
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  };

  return {
    containerRef,
    canvasRef,
    dragging,
    height,
    pan,
    resetPan: () => setPan({ x: 0, y: 0 }),
    panHandlers: {
      ...dragHandlers,
      onPointerDown: startPan,
      onPointerLeave: () => {
        if (gesture.current?.kind === "pan" && !gesture.current.dragged) {
          gesture.current = null;
        }
      },
      onClickCapture: (event: MouseEvent<HTMLElement>) => {
        if (!suppressClick.current) return;

        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
    resizeHandlers: {
      ...dragHandlers,
      onPointerDown: startResize,
      onKeyDown: resizeWithKeyboard,
    },
  };
}
