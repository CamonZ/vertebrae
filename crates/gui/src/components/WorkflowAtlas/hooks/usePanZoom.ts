import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Vertebrae · Workflow Atlas — pan/zoom hook (typed TS port of
 * docs/design/wf-panzoom.js).
 *
 * - drag anywhere on the container to pan (except [data-no-pan] elements)
 * - wheel / trackpad-pinch to zoom, anchored at the cursor
 * - fit() centers + scales content {w,h} into the container
 *
 * Apply `transform` (with `transform-origin: 0 0`) to the content wrapper.
 */

/** Affine transform state: uniform scale `s` plus translation `(x, y)`. */
export interface PanZoomTransform {
  s: number;
  x: number;
  y: number;
}

/** Content bounds (world-space dimensions) to fit into the container. */
export interface PanZoomContent {
  w: number;
  h: number;
}

export interface UsePanZoomOptions {
  /** Minimum scale (default 0.15). */
  min?: number;
  /** Maximum scale (default 2.4). */
  max?: number;
  /** Padding in px reserved around content when fitting (default 96). */
  pad?: number;
  /** Initial scale (default 1). */
  scale?: number;
}

export interface UsePanZoomResult {
  /** CSS `transform` string for the content wrapper. */
  transform: string;
  /** Current scale factor. */
  scale: number;
  /** Re-fit content to the container and re-enable auto-fit on resize. */
  fit: () => void;
  /** Zoom in around the container center. */
  zoomIn: () => void;
  /** Zoom out around the container center. */
  zoomOut: () => void;
  /** Reset to identity transform. */
  reset: () => void;
}

const ZOOM_STEP = 1.18;
const WHEEL_SENSITIVITY = 0.0016;

/** Clamp `v` into the inclusive range `[lo, hi]`. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Compute the transform that centers `content` inside a container of size
 * `cw × ch`, scaled to fit within `pad` padding and clamped to `[min, max]`.
 * Returns `null` when the container is not yet sized (so callers can wait for
 * the ResizeObserver instead of clamping to the minimum scale).
 */
export function fitTransform(
  cw: number,
  ch: number,
  content: PanZoomContent,
  min: number,
  max: number,
  pad: number,
): PanZoomTransform | null {
  if (cw < 2 || ch < 2) return null;
  if (content.w <= 0 || content.h <= 0) return null;
  const s = clamp(Math.min((cw - pad) / content.w, (ch - pad) / content.h), min, max);
  return { s, x: (cw - content.w * s) / 2, y: (ch - content.h * s) / 2 };
}

/**
 * Zoom the transform `prev` by `factor` while keeping the point `(px, py)` (in
 * container/screen coordinates) anchored, clamping scale to `[min, max]`.
 */
export function zoomAt(
  prev: PanZoomTransform,
  factor: number,
  px: number,
  py: number,
  min: number,
  max: number,
): PanZoomTransform {
  const ns = clamp(prev.s * factor, min, max);
  const k = ns / prev.s;
  return { s: ns, x: px - (px - prev.x) * k, y: py - (py - prev.y) * k };
}

export function usePanZoom(
  ref: React.RefObject<HTMLElement | null>,
  content: PanZoomContent,
  opts: UsePanZoomOptions = {},
): UsePanZoomResult {
  const min = opts.min ?? 0.15;
  const max = opts.max ?? 2.4;
  const pad = opts.pad ?? 96;

  const [t, setT] = useState<PanZoomTransform>({ s: opts.scale ?? 1, x: 0, y: 0 });
  const tref = useRef(t);
  tref.current = t;
  const contentRef = useRef(content);
  contentRef.current = content;
  // Becomes true once the user pans/zooms — stops auto-fit.
  const moved = useRef(false);

  // Listeners: pointer drag + non-passive wheel.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let drag: { x: number; y: number; ox: number; oy: number } | null = null;

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      if (target?.closest?.("[data-no-pan]")) return;
      drag = { x: e.clientX, y: e.clientY, ox: tref.current.x, oy: tref.current.y };
      el.classList.add("is-grabbing");
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      moved.current = true;
      const { ox, oy, x: sx, y: sy } = drag;
      setT((p) => ({ ...p, x: ox + (e.clientX - sx), y: oy + (e.clientY - sy) }));
    };
    const up = () => {
      drag = null;
      el.classList.remove("is-grabbing");
    };
    const wheel = (e: WheelEvent) => {
      // Let docked panels (Run Console, inspectors) scroll natively — don't
      // hijack the wheel to zoom the canvas underneath them.
      const target = e.target as Element | null;
      if (target?.closest?.("[data-no-pan]")) return;
      e.preventDefault();
      moved.current = true;
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const factor = Math.exp(-e.deltaY * WHEEL_SENSITIVITY);
      setT((p) => zoomAt(p, factor, px, py, min, max));
    };

    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el.removeEventListener("wheel", wheel);
    };
  }, [ref, min, max]);

  const api = useMemo(() => {
    const zoomCenter = (factor: number) => {
      const el = ref.current;
      if (!el) return;
      const px = el.clientWidth / 2;
      const py = el.clientHeight / 2;
      setT((p) => zoomAt(p, factor, px, py, min, max));
    };
    const autofit = () => {
      const el = ref.current;
      const c = contentRef.current;
      if (!el) return;
      const next = fitTransform(el.clientWidth, el.clientHeight, c, min, max, pad);
      if (next) setT(next);
    };
    return {
      _autofit: autofit,
      fit: () => {
        moved.current = false;
        autofit();
      },
      zoomIn: () => zoomCenter(ZOOM_STEP),
      zoomOut: () => zoomCenter(1 / ZOOM_STEP),
      reset: () => setT({ s: 1, x: 0, y: 0 }),
    };
  }, [ref, min, max, pad]);

  // Auto-fit once the container actually has a size, and on resize — until the
  // user takes control. Fixes the first-paint case where fit() ran against a
  // not-yet-laid-out (zero/low-height) canvas and clamped to the min scale.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!moved.current) api._autofit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, api]);

  return {
    transform: `translate(${t.x}px,${t.y}px) scale(${t.s})`,
    scale: t.s,
    fit: api.fit,
    zoomIn: api.zoomIn,
    zoomOut: api.zoomOut,
    reset: api.reset,
  };
}
