import { useLayoutEffect, useRef, useState, type RefObject } from "react";

type ZoomState = { zoom: number; x: number; y: number };
type WebKitGesture = Event & {
  scale: number;
  clientX: number;
  clientY: number;
};

function bounded(zoom: number) {
  const maximumBounded = Math.min(3, zoom);

  return Math.max(0.05, maximumBounded);
}

/** Canvas-local native listeners must be non-passive to suppress page zoom. */
export function useStatechartZoom(
  canvasRef: RefObject<HTMLSpanElement | null>,
  ready: boolean
) {
  const diagramRef = useRef<SVGSVGElement>(null);
  const [state, setState] = useState<ZoomState>({ zoom: 1, x: 0, y: 0 });
  const current = useRef(state);
  const rendered = useRef(state);
  const pendingScroll = useRef<{ x: number; y: number } | null>(null);

  // Shrinking overflow can clamp native scroll offsets. Correct the translation
  // after layout, before paint, so the pointer anchor survives that clamp too.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const scroll = pendingScroll.current;

    pendingScroll.current = null;
    rendered.current = state;

    if (!canvas || !scroll) return;

    const x = canvas.scrollLeft - scroll.x;
    const y = canvas.scrollTop - scroll.y;

    if (x || y) {
      const corrected = { ...state, x: state.x + x, y: state.y + y };

      current.current = corrected;
      setState(corrected);
    }
  }, [canvasRef, state]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;

    if (!ready || !canvas) return;

    let gestureScale: number | null = null;

    function zoomAt(factor: number, clientX: number, clientY: number) {
      const diagram = diagramRef.current;

      if (!canvas || !diagram || !Number.isFinite(factor) || factor <= 0)
        return;

      const previous = current.current;
      const requestedZoom = previous.zoom * factor;
      const zoom = bounded(requestedZoom);
      const ratio = zoom / previous.zoom;
      const bounds = diagram.getBoundingClientRect();

      // Account for input arriving before React commits the previous event.
      const left = bounds.left + previous.x - rendered.current.x;
      const top = bounds.top + previous.y - rendered.current.y;
      const next = {
        zoom,
        x: previous.x + (clientX - left) * (1 - ratio),
        y: previous.y + (clientY - top) * (1 - ratio),
      };

      pendingScroll.current = { x: canvas.scrollLeft, y: canvas.scrollTop };
      current.current = next;
      setState(next);
    }

    function wheel(event: WheelEvent) {
      if (!event.ctrlKey) return;

      event.preventDefault();
      event.stopPropagation();

      // WebKit gestures own the pinch while active; avoid double application.
      if (gestureScale !== null) return;

      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? canvas!.clientHeight
            : 1;
      const delta = event.deltaY * unit;

      if (!Number.isFinite(delta)) return;

      const maximumDelta = Math.min(240, delta);
      const boundedDelta = Math.max(-240, maximumDelta);
      const factor = Math.exp(-boundedDelta * 0.002);

      zoomAt(factor, event.clientX, event.clientY);
    }

    // WKWebView can deliver Safari GestureEvents instead of Ctrl-wheel pinch.
    function gesture(event: Event) {
      const input = event as WebKitGesture;

      if (!Number.isFinite(input.scale) || input.scale <= 0) return;
      if (event.type !== "gesturestart" && gestureScale === null) return;

      event.preventDefault();
      event.stopPropagation();

      if (event.type === "gesturestart") {
        gestureScale = input.scale;
      } else {
        const factor = input.scale / gestureScale!;

        zoomAt(factor, input.clientX, input.clientY);

        gestureScale = event.type === "gestureend" ? null : input.scale;
      }
    }

    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("gesturestart", gesture, { passive: false });
    canvas.addEventListener("gesturechange", gesture, { passive: false });
    canvas.addEventListener("gestureend", gesture, { passive: false });

    return () => {
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("gesturestart", gesture);
      canvas.removeEventListener("gesturechange", gesture);
      canvas.removeEventListener("gestureend", gesture);
    };
  }, [canvasRef, ready]);

  function setZoom(value: number | ((zoom: number) => number), reset = false) {
    const previous = current.current;
    const requestedZoom =
      typeof value === "function" ? value(previous.zoom) : value;
    const zoom = bounded(requestedZoom);
    const next = { zoom, x: reset ? 0 : previous.x, y: reset ? 0 : previous.y };

    pendingScroll.current = null;
    current.current = next;
    setState(next);
  }

  return { ...state, setZoom, diagramRef };
}
