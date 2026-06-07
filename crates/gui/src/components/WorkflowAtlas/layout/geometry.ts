/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — geometry primitives (pure).

   Ported from the `docs/design/` prototype (workflow-views.jsx `roundedPath`,
   wf-elk.js `edgePoints` / `splitRef` / `rayBox` / `borderAnchor` / `anchorEdge`,
   wf-detail.jsx `shortId`). These are framework-free and shared by both layout
   ports (`layoutFull`, `layoutCondensed`) and the edge renderers.
   ────────────────────────────────────────────────────────────────── */

import type { ElkEdgeSection } from "elkjs/lib/elk.bundled.js";
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
 * Stable 8-hex-char hash of an id, for the small `#abc12345` chips shown on
 * cards/inspectors. djb2-ish (×31) hash, ported from `wf-detail.jsx::shortId`.
 */
export function shortId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16).slice(0, 8).padStart(8, "0");
}

/**
 * Flatten an ELK edge section (start → bends → end) into an absolute point
 * list, offsetting by `(ox, oy)` (a container's origin for intra edges, or
 * `0,0` for root edges). Ported from `wf-elk.js::edgePoints`.
 */
export function edgePoints(
  section: ElkEdgeSection | undefined,
  ox: number,
  oy: number,
): Point[] {
  const pts: Point[] = [];
  if (section) {
    pts.push(section.startPoint);
    (section.bendPoints ?? []).forEach((p) => pts.push(p));
    pts.push(section.endPoint);
  }
  return pts.map((p) => ({ x: p.x + ox, y: p.y + oy }));
}

/* ── edge ↔ box anchoring ───────────────────────────────────────────
   ELK (and the hub overlay) can hand back cross-edge endpoints that sit at a
   container's centre or trail under its box. Re-anchor both ends onto the
   workflow bounding-box border so every transition visibly enters/leaves the
   box edge, never its interior. Ported from `wf-elk.js`. */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Is point `p` inside (optionally padded) rect `b`? */
function inBox(p: Point, b: Rect, pad = 0): boolean {
  return (
    p.x >= b.x - pad &&
    p.x <= b.x + b.w + pad &&
    p.y >= b.y - pad &&
    p.y <= b.y + b.h + pad
  );
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
  b: Rect,
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

/**
 * Anchor one edge end to box `b`, given the neighbouring point `nb` (assumed
 * outside `b`). Keeps an orthogonal approach when `nb` lines up with a face;
 * else trims to the border along the centre→`nb` ray.
 * Ported from `wf-elk.js::borderAnchor`.
 */
export function borderAnchor(b: Rect, nb: Point): Point {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  // vertical approach: nb sits within the box's x-span → snap to top/bottom face
  if (nb.x >= b.x && nb.x <= b.x + b.w) {
    return { x: clamp(nb.x, b.x, b.x + b.w), y: nb.y <= cy ? b.y : b.y + b.h };
  }
  // horizontal approach: nb sits within the box's y-span → snap to left/right face
  if (nb.y >= b.y && nb.y <= b.y + b.h) {
    return { x: nb.x <= cx ? b.x : b.x + b.w, y: clamp(nb.y, b.y, b.y + b.h) };
  }
  // diagonal: trim to border along the centre → nb ray
  return rayBox(cx, cy, nb.x, nb.y, b);
}

/**
 * Drop points buried inside either endpoint box, then snap both ends to the
 * borders of boxes `A` (source) and `B` (target).
 * Ported from `wf-elk.js::anchorEdge`.
 */
export function anchorEdge(pts: Point[], A: Rect, B: Rect): Point[] {
  if (!pts || pts.length < 2) return pts;
  let s = 0;
  let e = pts.length - 1;
  while (s < e - 1 && inBox(pts[s + 1], A)) s++;
  while (e > s + 1 && inBox(pts[e - 1], B)) e--;
  const out = pts.slice(s, e + 1);
  out[0] = borderAnchor(A, out[1]);
  out[out.length - 1] = borderAnchor(B, out[out.length - 2]);
  return out;
}
