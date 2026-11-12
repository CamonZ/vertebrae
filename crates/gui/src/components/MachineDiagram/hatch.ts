/** Frame bounding box in part space. */
export type BBox = readonly [x: number, y: number, w: number, h: number];

/** Hatch line spacing and the frame inset/radius the hatch is clipped to (gallery `drawPart`). */
export const HATCH_STEP = 16;
export const GHOST_PAD = 8;
export const GHOST_RADIUS = 24;

/**
 * Hatch strokes over a frame, as the gallery draws them: 45° lines rising to
 * the right, every 16 px, anchored at the frame's bottom-left corner so the
 * phase follows the frame rather than the canvas.
 */
export function hatchPath([x, y, w, h]: BBox): string {
  const X = x - GHOST_PAD;
  const H = h + 2 * GHOST_PAD;
  const W = w + 2 * GHOST_PAD;
  const out: string[] = [];
  for (let d = -H; d < W; d += HATCH_STEP)
    out.push(`M${X + d} ${y + h + GHOST_PAD} L${X + d + H} ${y - GHOST_PAD}`);
  return out.join(" ");
}
