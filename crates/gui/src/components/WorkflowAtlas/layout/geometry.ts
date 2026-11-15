/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — geometry primitives (pure).

   Ported from the `docs/design/` prototype (workflow-views.jsx `roundedPath`,
   wf-elk.js `splitRef` / `rayBox`). These are framework-free and shared by the
   Map layout (`layoutCondensed`), the factory overview and the edge renderers.
   ────────────────────────────────────────────────────────────────── */

import type { Point, Rect } from "./types";

/**
 * Build an SVG path string through an orthogonal point list, rounding each
 * interior corner with radius `r` (clamped to half the shorter adjacent leg
 * so short segments never overshoot). Ported verbatim from
 * `workflow-views.jsx::roundedPath`.
 */
export function roundedPath(pts: Point[], r: number): string {
  if (!pts || pts.length < 2) return "";
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const v1x = Math.sign(p1.x - p0.x);
    const v1y = Math.sign(p1.y - p0.y);
    const v2x = Math.sign(p2.x - p1.x);
    const v2y = Math.sign(p2.y - p1.y);
    const r1 = Math.min(r, Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2);
    const r2 = Math.min(r, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2);
    d += ` L${p1.x - v1x * r1},${p1.y - v1y * r1} Q${p1.x},${p1.y} ${
      p1.x + v2x * r2
    },${p1.y + v2y * r2}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last.x},${last.y}`;
  return d;
}

/**
 * Split a step ref (`"<workflowId>.<stepId>"`) at the first dot.
 * Workflow ids may themselves contain dots is not expected, but stepIds can —
 * splitting on the *first* dot matches the prototype's `splitRef`.
 */
export function splitRef(ref: string): [workflowId: string, stepId: string] {
  const i = ref.indexOf(".");
  return [ref.slice(0, i), ref.slice(i + 1)];
}

/**
 * Intersection of the ray `(cx,cy) → (tx,ty)` with rect `b`'s border.
 * Used to anchor a cross/hub edge endpoint onto a workflow box border.
 * Ported from `wf-elk.js::rayBox`.
 */
export function rayBox(
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  b: Rect
): Point {
  const dx = tx - cx;
  const dy = ty - cy;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (b.x + b.w - cx) / dx);
  else if (dx < 0) t = Math.min(t, (b.x - cx) / dx);
  if (dy > 0) t = Math.min(t, (b.y + b.h - cy) / dy);
  else if (dy < 0) t = Math.min(t, (b.y - cy) / dy);
  if (!isFinite(t) || t < 0) t = 0;
  return { x: cx + dx * t, y: cy + dy * t };
}
