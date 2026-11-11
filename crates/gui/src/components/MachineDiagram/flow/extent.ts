/**
 * Where a compiled diagram draws its text and frames, in diagram space, as
 * boxes estimated from the renderers (MachinePart, ChangeMark, StatusLine,
 * Wire, FlowDiagram). Auto-layout sizes each part's node from its extent so
 * neighbouring labels cannot collide, and tests check the laid-out pictures
 * with the same boxes. Monospace text is estimated at 0.6 em per character
 * and 1.2 em per line.
 */
import type { TextAlign } from "../SvgText";
import type {
  DiagramPart,
  DiagramRail,
  DiagramRegion,
  DiagramTimeline,
} from "./compile";
import type { Point } from "../route";

export interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export type LabelKind =
  | "title"
  | "note"
  | "aka"
  | "status"
  | "tab"
  | "name"
  | "rail"
  | "mark"
  | "region";

export interface LabelBox extends Box {
  readonly kind: LabelKind;
  /** Part, rail or region id the label belongs to. */
  readonly owner: string;
  readonly text: string;
}

/** Monospace advance per px of font size (JetBrains Mono / IBM Plex Mono ≈ 0.6 em). */
export const CHAR_EM = 0.6;
/** Line box per px of font size. */
export const LINE_EM = 1.2;
/** Hover/focus ring padding around a frame (MachinePart RING_PAD). */
export const RING_PAD = 14;
/** Rail label size and its offset under the rail (Wire). */
export const RAIL_LABEL_SIZE = 18;
export const RAIL_LABEL_DY = 22;
/** Name drawn above a part cell under full scale (FlowDiagram). */
export const NAME_SIZE = 20;
export const NAME_DY = 12;
/** Region frame padding around its parts, and room for its name on top. */
export const REGION_PAD = 24;
export const REGION_HEAD = 48;
export const REGION_LABEL_SIZE = 18;
/** Pill gate half-extents when fully open (Gate, `offset` up to 24). */
const GATE_HALF_LONG = 34;
const GATE_HALF_SHORT = 4.5;

export const textWidth = (text: string, size: number) =>
  text.length * size * CHAR_EM;

/** A single line centred on `y` (SvgText uses dominant-baseline middle). */
export function textBox(
  x: number,
  y: number,
  text: string,
  size: number,
  align: TextAlign = "left"
): Box {
  const w = textWidth(text, size);
  const h = size * LINE_EM;
  const x0 = align === "left" ? x : align === "center" ? x - w / 2 : x - w;
  return { x0, y0: y - h / 2, x1: x0 + w, y1: y + h / 2 };
}

export function union(boxes: readonly Box[]): Box {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

export const overlaps = (a: Box, b: Box) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export const pad = (b: Box, px: number, top = px): Box => ({
  x0: b.x0 - px,
  y0: b.y0 - top,
  x1: b.x1 + px,
  y1: b.y1 + px,
});

const shift = (b: Box, x: number, y: number): Box => ({
  x0: b.x0 + x,
  y0: b.y0 + y,
  x1: b.x1 + x,
  y1: b.y1 + y,
});

/** Part space → diagram space, relative to the cell's top-left. */
const scaled = (b: Box, s: number): Box => ({
  x0: b.x0 * s,
  y0: b.y0 * s,
  x1: b.x1 * s,
  y1: b.y1 * s,
});

const TAB_TEXT = {
  added: "+ added",
  changed: "~ changed",
  removed: "− removed",
} as const;

type PartGeometry = Pick<
  DiagramPart,
  | "id"
  | "identity"
  | "scale"
  | "bb"
  | "status"
  | "change"
  | "changeNote"
  | "timeline"
  | "ports"
  | "presence"
>;

/** The frame (bounding box), relative to the cell's top-left. */
export function frameLocal(p: Pick<DiagramPart, "bb" | "scale">): Box {
  const [x, y, w, h] = p.bb;
  return scaled({ x0: x, y0: y, x1: x + w, y1: y + h }, p.scale);
}

/** Every label the part draws, relative to the cell's top-left. */
export function partLabelsLocal(p: PartGeometry): LabelBox[] {
  const s = p.scale;
  const out: LabelBox[] = [];
  const add = (kind: LabelKind, text: string, b: Box, inPartSpace = true) =>
    out.push({ ...(inPartSpace ? scaled(b, s) : b), kind, owner: p.id, text });
  if (s >= 1) {
    // MachinePart: title, change note and "also" line; status line; tab.
    const title = `${p.identity.name}  ·  ${p.identity.job}`;
    add("title", title, textBox(24, 36, title, 22));
    if (p.change === "changed" && p.changeNote)
      add("note", p.changeNote, textBox(24, 64, p.changeNote, 18));
    if (p.identity.aka) {
      const aka = `also  ${p.identity.aka}`;
      add("aka", aka, textBox(24, 380, aka, 18));
    }
    const texts = new Set(p.timeline.notes.map(([, text]) => text));
    for (const text of texts)
      add(
        "status",
        text,
        textBox(p.status.x, p.status.y, text, 20, p.status.align ?? "center")
      );
    if (p.change !== "unchanged") {
      const text = TAB_TEXT[p.change];
      const tx = p.bb[0] - 8 + 22;
      const ty = p.bb[1] - 8;
      add("tab", text, {
        x0: tx,
        y0: ty - 14,
        x1: tx + text.length * 10.8 + 20,
        y1: ty + 14,
      });
    }
  } else {
    // FlowDiagram names a part drawn under full scale above its frame.
    const name = p.identity.name;
    const [x, y] = nameLabelLocal(p);
    add("name", name, textBox(x, y, name, NAME_SIZE, "center"), false);
  }
  return out;
}

/**
 * Centre of the name FlowDiagram draws above a part under full scale,
 * relative to the cell's top-left: above the frame and any gate pill on it.
 */
export function nameLabelLocal(
  p: Pick<DiagramPart, "bb" | "scale" | "timeline">
): Point {
  const top = Math.min(frameLocal(p).y0, ...gatesLocal(p).map((g) => g.y0));
  return [(p.bb[0] + p.bb[2] / 2) * p.scale, top - NAME_DY];
}

/** Gate pills at their widest, relative to the cell's top-left. */
export function gatesLocal(p: Pick<DiagramPart, "timeline" | "scale">): Box[] {
  return p.timeline.gates.map((g) =>
    scaled(
      g.orientation === "v"
        ? {
            x0: g.x - GATE_HALF_SHORT,
            y0: g.y - GATE_HALF_LONG,
            x1: g.x + GATE_HALF_SHORT,
            y1: g.y + GATE_HALF_LONG,
          }
        : {
            x0: g.x - GATE_HALF_LONG,
            y0: g.y - GATE_HALF_SHORT,
            x1: g.x + GATE_HALF_LONG,
            y1: g.y + GATE_HALF_SHORT,
          },
      p.scale
    )
  );
}

/**
 * Everything the part draws that its neighbours must stay clear of: the
 * frame with its change mark and focus ring, gates, labels and ports,
 * relative to the cell's top-left.
 */
export function partExtentLocal(p: PartGeometry): Box {
  const ports = Object.values(p.ports).map(({ local: [x, y] }) => ({
    x0: x * p.scale,
    y0: y * p.scale,
    x1: x * p.scale,
    y1: y * p.scale,
  }));
  return union([
    pad(frameLocal(p), RING_PAD),
    ...gatesLocal(p),
    ...partLabelsLocal(p),
    ...ports,
  ]);
}

const atCell = (p: Pick<DiagramPart, "position">, b: Box) =>
  shift(b, p.position.x, p.position.y);

export const partFrame = (p: DiagramPart) => atCell(p, frameLocal(p));
export const partExtent = (p: DiagramPart) => atCell(p, partExtentLocal(p));
export const partGates = (p: DiagramPart) =>
  gatesLocal(p).map((g) => atCell(p, g));
export const partLabels = (p: DiagramPart): LabelBox[] =>
  partLabelsLocal(p).map((l) => ({ ...l, ...atCell(p, l) }));

/** The text a laid-out rail label draws: change glyph, then the label. */
export function railLabelText(
  r: Pick<DiagramRail, "label" | "change">
): string | undefined {
  const glyph =
    r.change === "added" ? "+" : r.change === "removed" ? "×" : undefined;
  if (glyph && r.label) return `${glyph} ${r.label}`;
  return glyph ?? r.label;
}

/** Midpoint Wire uses when a rail has no laid-out label position. */
export function railMid(points: readonly Point[]): Point {
  if (points.length === 2)
    return [
      (points[0][0] + points[1][0]) / 2,
      (points[0][1] + points[1][1]) / 2,
    ];
  return points[Math.floor(points.length / 2)];
}

/** Rail label (and change glyph) boxes in diagram space. */
export function railLabels(r: DiagramRail): LabelBox[] {
  const text = railLabelText(r);
  if (!text) return [];
  if (r.labelAt) {
    const [x, y] = r.labelAt;
    return [
      {
        ...textBox(x, y, text, RAIL_LABEL_SIZE, "center"),
        kind: "rail",
        owner: r.id,
        text,
      },
    ];
  }
  // Hand-routed: Wire draws the glyph above and the label under the midpoint.
  const out: LabelBox[] = [];
  const [mx, my] = railMid(r.points);
  if (r.change !== "unchanged")
    out.push({
      ...textBox(mx, my - 20, "+", 22, "center"),
      kind: "mark",
      owner: r.id,
      text: r.change === "added" ? "+" : "×",
    });
  if (r.label)
    out.push({
      ...textBox(mx, my + RAIL_LABEL_DY, r.label, RAIL_LABEL_SIZE, "center"),
      kind: "rail",
      owner: r.id,
      text: r.label,
    });
  return out;
}

/** Where a region names itself: inside its top-left corner. */
export function regionLabelAt(g: DiagramRegion): Point {
  return [g.x + 20, g.y + REGION_HEAD / 2];
}

export function regionLabels(g: DiagramRegion): LabelBox[] {
  if (!g.label) return [];
  const [x, y] = regionLabelAt(g);
  return [
    {
      ...textBox(x, y, g.label, REGION_LABEL_SIZE),
      kind: "region",
      owner: g.id,
      text: g.label,
    },
  ];
}

/**
 * Every label in a picture that collides with a part's frame, a gate or
 * another owner's label, as readable descriptions (empty when clear). A
 * part's change tab hangs on its own frame by design, so that pair is
 * allowed.
 */
export function labelCollisions(
  d: Pick<DiagramTimeline, "parts" | "rails" | "regions">
): string[] {
  const drawn = d.parts.filter((p) => p.presence !== "absent");
  const labels: LabelBox[] = [
    ...drawn.flatMap(partLabels),
    ...d.rails.filter((r) => r.presence !== "absent").flatMap(railLabels),
    ...d.regions.flatMap(regionLabels),
  ];
  const solids: { owner: string; what: string; box: Box }[] = [
    ...drawn.map((p) => ({
      owner: p.id,
      what: `frame ${p.id}`,
      box: partFrame(p),
    })),
    ...drawn.flatMap((p) =>
      partGates(p).map((box, i) => ({
        owner: p.id,
        what: `gate ${p.id}#${i}`,
        box,
      }))
    ),
  ];
  const name = (l: LabelBox) => `${l.kind} ${l.owner} "${l.text}"`;
  const out: string[] = [];
  labels.forEach((l, i) => {
    for (const s of solids) {
      if (l.kind === "tab" && s.owner === l.owner && s.what.startsWith("frame"))
        continue;
      if (overlaps(l, s.box)) out.push(`${name(l)} × ${s.what}`);
    }
    for (const m of labels.slice(i + 1))
      if (m.owner !== l.owner && overlaps(l, m))
        out.push(`${name(l)} × ${name(m)}`);
  });
  return out;
}
