/**
 * Flow direction: which way cards travel across a diagram. Parts are
 * authored left to right in their 640×400 part space; a direction turns
 * that space as a whole (mirror for `left`, transpose for `down`, a quarter
 * turn for `up`) while text stays upright. Auto-layout runs in the
 * canonical left-to-right frame and its result is turned the same way, so
 * routing and topology code stay single-axis.
 *
 * Every turn maps the part's forward axis (east) to the flow direction and
 * the part's top (north) to a side across the flow: north stays north for
 * `left`, and becomes west for `down` and `up`.
 */
import type { Point, PortSide } from "./route";
import { PART_HEIGHT, PART_WIDTH } from "./partGeometry";
import type { TextAlign } from "./SvgText";

export const FLOW_DIRECTIONS = ["right", "left", "down", "up"] as const;
export type FlowDirection = (typeof FLOW_DIRECTIONS)[number];

/** Affine map `x' = a·x + c·y + e`, `y' = b·x + d·y + f` (SVG `matrix`). */
export interface Affine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** The linear part of each turn. */
const LINEAR: Record<FlowDirection, readonly [number, number, number, number]> =
  {
    right: [1, 0, 0, 1],
    left: [-1, 0, 0, 1],
    down: [0, 1, 1, 0],
    up: [0, -1, 1, 0],
  };

/** Whether the turn swaps the axes (cells become 400×640). */
export const transposes = (dir: FlowDirection) =>
  dir === "down" || dir === "up";

/** Size of a turned part space (or of a cell at `scale`). */
export function turnedSize(
  dir: FlowDirection,
  scale = 1
): readonly [number, number] {
  return transposes(dir)
    ? [PART_HEIGHT * scale, PART_WIDTH * scale]
    : [PART_WIDTH * scale, PART_HEIGHT * scale];
}

/**
 * Part space → turned part space: the linear turn plus the translation that
 * keeps the turned cell at the origin.
 */
export function partTurn(dir: FlowDirection, scale = 1): Affine {
  const [a, b, c, d] = LINEAR[dir];
  const w = PART_WIDTH * scale;
  return {
    a,
    b,
    c,
    d,
    e: dir === "left" ? w : 0,
    f: dir === "up" ? w : 0,
  };
}

/** A pure linear turn with a translation (diagram space). */
export function linearTurn(dir: FlowDirection, e = 0, f = 0): Affine {
  const [a, b, c, d] = LINEAR[dir];
  return { a, b, c, d, e, f };
}

export function apply(m: Affine, [x, y]: Point): Point {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

export function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return {
    a,
    b,
    c,
    d,
    e: -(a * m.e + c * m.f),
    f: -(b * m.e + d * m.f),
  };
}

export const isIdentity = (m: Affine) =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

/** SVG `transform` value of `m`. */
export const svgMatrix = (m: Affine) =>
  `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;

export interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** An axis-aligned box through an axis-aligned map (turns keep boxes boxes). */
export function applyBox(m: Affine, b: Box): Box {
  const [ax, ay] = apply(m, [b.x0, b.y0]);
  const [bx, by] = apply(m, [b.x1, b.y1]);
  return {
    x0: Math.min(ax, bx),
    y0: Math.min(ay, by),
    x1: Math.max(ax, bx),
    y1: Math.max(ay, by),
  };
}

const OUTWARD: Record<PortSide, Point> = {
  W: [-1, 0],
  E: [1, 0],
  N: [0, -1],
  S: [0, 1],
};

/** The side a part-space side faces once turned. */
export function turnSide(dir: FlowDirection, side: PortSide): PortSide {
  if (dir === "right") return side;
  const [a, b, c, d] = LINEAR[dir];
  const [x, y] = OUTWARD[side];
  const ox = a * x + c * y;
  const oy = b * x + d * y;
  return ox > 0 ? "E" : ox < 0 ? "W" : oy > 0 ? "S" : "N";
}

/**
 * Text alignment in a turned drawing. A mirror flips start and end, so a
 * label that ran with the flow still does; a transpose keeps it.
 */
export function turnAlign(
  dir: FlowDirection,
  align: TextAlign | undefined
): TextAlign | undefined {
  if (dir !== "left" || align === undefined || align === "center") return align;
  return align === "left" ? "right" : "left";
}

/** The rectangle `[x, y, w, h]` (a part's `bb`) through `m`. */
export function applyRect(
  m: Affine,
  [x, y, w, h]: readonly [number, number, number, number]
): [number, number, number, number] {
  const b = applyBox(m, { x0: x, y0: y, x1: x + w, y1: y + h });
  return [b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0];
}

/** Status line anchor in turned part space (see `turnStatus`). */
export interface TextAnchor {
  readonly x: number;
  readonly y: number;
  readonly align?: TextAlign;
}

/**
 * Where a part's status line sits once turned. The anchor turns with the
 * part; a transpose moves text that sat under the frame beside it, so the
 * line starts at the anchor (or ends there on the other side) instead of
 * straddling the frame.
 */
export function turnStatus(dir: FlowDirection, s: TextAnchor): TextAnchor {
  if (dir === "right") return s;
  const [x, y] = apply(partTurn(dir), [s.x, s.y]);
  if (!transposes(dir)) return { x, y, align: turnAlign(dir, s.align) };
  return { x, y, align: x >= PART_HEIGHT / 2 ? "left" : "right" };
}

/** Gate pill half length and clearance beside the rail axis of a turned part. */
const AXIS_CLEAR = 34 + 10;

/**
 * Anchors of the title, change note and "also" line in the turned part
 * space. Left to right and right to left keep the top-left corner. Down
 * and up stack them above the turned frame, starting past the rail axis
 * (x = 200) and the gate pill on it, so the rail entering or leaving the
 * top of the part runs clear of them; the "also" line goes under the frame.
 */
export function titleAnchors(
  dir: FlowDirection,
  bb: readonly [number, number, number, number]
): {
  readonly title: Point;
  readonly note: Point;
  readonly aka: Point;
} {
  if (!transposes(dir))
    return { title: [24, 36], note: [24, 64], aka: [24, 380] };
  const [, y, , h] = applyRect(partTurn(dir), bb);
  const x = PART_HEIGHT / 2 + AXIS_CLEAR;
  const note = y - 4 - 18 * 0.6;
  return {
    title: [x, Math.min(36, note - 28)],
    note: [x, note],
    aka: [x, y + h + 4 + 18 * 0.6 + 8],
  };
}

/**
 * Change tab position (left end, centre line) in the turned part space, or
 * undefined for the default (on the frame's top edge at its left corner).
 * Down and up put it on the top edge left of the rail axis and its gate,
 * leaving the right of the axis to the title.
 */
export function tabAnchor(
  dir: FlowDirection,
  bb: readonly [number, number, number, number],
  width: number
): Point | undefined {
  if (!transposes(dir)) return undefined;
  const [, y] = applyRect(partTurn(dir), bb);
  return [PART_HEIGHT / 2 - AXIS_CLEAR - width, y - 8];
}

/**
 * A part's frame and timeline gates in the turned part space, for label
 * placement that reads them (`placedLabels`). Left to right: unchanged.
 */
export function turnedLabelGeometry<
  T extends {
    readonly gates: readonly {
      readonly x: number;
      readonly y: number;
      readonly orientation: "v" | "h";
    }[];
  },
>(
  dir: FlowDirection,
  bb: readonly [number, number, number, number],
  timeline: T
): { bb: [number, number, number, number]; timeline: T } {
  if (dir === "right") return { bb: [...bb], timeline };
  const m = partTurn(dir);
  return {
    bb: applyRect(m, bb),
    timeline: {
      ...timeline,
      gates: timeline.gates.map((g) => {
        const [x, y] = apply(m, [g.x, g.y]);
        const orientation = transposes(dir)
          ? g.orientation === "v"
            ? ("h" as const)
            : ("v" as const)
          : g.orientation;
        return { ...g, x, y, orientation };
      }),
    },
  };
}

/**
 * Placed header labels of a part turned down or up start past the rail axis
 * and its gate, so the rail meeting the top of the frame runs clear of them.
 */
export function besideAxis<
  L extends {
    readonly x: number;
    readonly box: { x0: number; y0: number; x1: number; y1: number };
  },
>(dir: FlowDirection, scale: number, labels: readonly L[]): L[] {
  if (!transposes(dir) || labels.length === 0) return [...labels];
  const start = (PART_HEIGHT / 2 + AXIS_CLEAR) * scale;
  const dx = Math.max(0, start - Math.min(...labels.map((l) => l.box.x0)));
  return labels.map((l) => ({
    ...l,
    x: l.x + dx,
    box: { ...l.box, x0: l.box.x0 + dx, x1: l.box.x1 + dx },
  }));
}
