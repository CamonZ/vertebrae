/**
 * The band: a strip under a flow diagram, below a divider, that summarises
 * what the machine does between story beats (spec `band`). One row per
 * situation, its name and note, then a chain of dashed chips; a row lights
 * while the shown time is inside one of its beat windows. A meter on the
 * right counts the markers of one kind the compile produced (e.g. `spawn`).
 *
 * The geometry — divider, heading, row lines, chip column, meter position
 * and the canvas it needs — is laid out once for every arrangement, below
 * everything the diagram draws, so Before and After line up and only the
 * row contents and the meter change.
 */
import type { TimelineMarker } from "../timeline";
import type { ArrangementName, BandSpec, PerArrangement } from "./spec";
import { LINE_EM, textWidth, type Box } from "./measure";

/** Space between the lowest drawn element and the divider. */
export const BAND_GAP = 70;
export const BAND_DIVIDER = 2;
export const BAND_HEADING_DY = 35;
export const BAND_HEADING_SIZE = 20;
/** Letter spacing of the heading, in px per character. */
export const BAND_HEADING_SPACING = 2.5;
/** Divider to the first row's centre line, and row to row. */
export const BAND_FIRST_ROW_DY = 90;
export const BAND_ROW_STEP = 48;
export const BAND_NAME_SIZE = 22;
export const BAND_CHIP_SIZE = 18;
export const BAND_CHIP_HEIGHT = 34;
/** Text inset inside a chip, each side. */
export const BAND_CHIP_PAD = 14;
/** Dashed connector between two chips. */
export const BAND_CHIP_LINK = 24;
/** Name column to the first chip. */
export const BAND_CHIP_GAP = 40;
/** Last chip to the meter. */
export const BAND_METER_GAP = 80;
export const BAND_METER_RING = 12;
export const BAND_METER_RING_STEP = 40;
export const BAND_FOOTNOTE_SIZE = 18;
/** Below the last row or the meter footnote. */
export const BAND_PAD = 40;

/** The separator drawn between a row's name and its note. */
export const BAND_NOTE_SEP = "  ·  ";

export interface DiagramBandChip {
  readonly text: string;
  /** Left edge in diagram space; the chip is centred on its row's `y`. */
  readonly x: number;
  readonly width: number;
}

export interface DiagramBandRow {
  readonly name: string;
  readonly note?: string;
  /** Centre line in diagram space; the same in every arrangement. */
  readonly y: number;
  readonly chips: readonly DiagramBandChip[];
  /** `[start, end)` story windows (seconds) during which the row is lit. */
  readonly windows: readonly (readonly [number, number])[];
}

export interface DiagramBandMeter {
  readonly label: string;
  /** Marker kinds counted. */
  readonly markers: readonly string[];
  /** Left edge of the meter; the same in every arrangement. */
  readonly x: number;
  readonly labelY: number;
  readonly ringsY: number;
  readonly footnoteY: number;
  /** When each counted marker happens in this arrangement, sorted: one ring each. */
  readonly times: readonly number[];
  readonly footnote?: string;
}

export interface DiagramBand {
  /** Divider from x0 to x1 at y (its top edge). */
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
  readonly heading?: string;
  readonly headingY: number;
  /** Left edge of every row's first chip. */
  readonly chipX: number;
  readonly rows: readonly DiagramBandRow[];
  readonly meter?: DiagramBandMeter;
  /** Bottom of the band, padding included. */
  readonly y1: number;
}

/** Whether a band row is lit at shown time `t`. */
export function bandRowLit(
  row: Pick<DiagramBandRow, "windows">,
  t: number
): boolean {
  return row.windows.some(([a, b]) => a <= t && t < b);
}

/** How many of the meter's markers have happened by shown time `t`. */
export function meterCount(m: Pick<DiagramBandMeter, "times">, t: number) {
  let n = 0;
  for (const at of m.times) if (at <= t) n++;
  return n;
}

/** The value of a per-arrangement field (`current` reads the After side). */
export function sideOf<T>(
  v: PerArrangement<T> | undefined,
  a: ArrangementName
): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "object" && v !== null && "before" in v && "after" in v)
    return a === "before" ? v.before : v.after;
  return v as T;
}

/** Width of the heading as drawn with its letter spacing. */
export const headingWidth = (text: string) =>
  textWidth(text, BAND_HEADING_SIZE) + text.length * BAND_HEADING_SPACING;

export const chipWidth = (text: string) =>
  textWidth(text, BAND_CHIP_SIZE) + 2 * BAND_CHIP_PAD;

/** The line a row draws before its chips: name, then the note. */
export const rowLine = (name: string, note: string | undefined) =>
  note ? `${name}${BAND_NOTE_SEP}${note}` : name;

/** Where a chip draws its text: inset from the pill's left edge. */
export const chipTextX = (c: Pick<DiagramBandChip, "x">) => c.x + BAND_CHIP_PAD;

/** The "n of N" text, at its widest. */
export const meterCountText = (n: number, total: number) => `${n} of ${total}`;

/** Centre x of ring `i`. */
export const ringX = (m: Pick<DiagramBandMeter, "x">, i: number) =>
  m.x + BAND_METER_RING + i * BAND_METER_RING_STEP;

/** Left edge of the "n of N" count, a ring step after the last of `total` rings. */
export const meterCountX = (m: Pick<DiagramBandMeter, "x">, total: number) =>
  ringX(m, total);

function meterWidth(label: string, total: number, footnote?: string): number {
  const count =
    meterCountX({ x: 0 }, total) +
    textWidth(meterCountText(total, total), BAND_NAME_SIZE);
  return Math.max(
    textWidth(label, BAND_NAME_SIZE),
    count,
    footnote ? textWidth(footnote, BAND_FOOTNOTE_SIZE) : 0
  );
}

/** One arrangement's view of the band, before geometry. */
export interface BandInput {
  readonly arrangement: ArrangementName;
  readonly markers: readonly TimelineMarker[];
  /** Story windows by beat id in this arrangement. */
  readonly windows: ReadonlyMap<string, readonly [number, number]>;
}

/**
 * Lay out the band under `content` (everything the diagram draws, over
 * every arrangement) once for all arrangements, and fill each one's rows
 * and meter. Returns one band per input, in order.
 */
export function layoutBand(
  spec: BandSpec,
  inputs: readonly BandInput[],
  content: Box
): DiagramBand[] {
  const x0 = Math.max(0, content.x0);
  const y = content.y1 + BAND_GAP;
  const firstRow = y + BAND_FIRST_ROW_DY;
  const resolved = inputs.map((d) =>
    spec.rows.map((r) => ({
      name: r.name,
      note: sideOf(r.note, d.arrangement),
      chips: sideOf(r.chips, d.arrangement) ?? [],
    }))
  );
  const nameW = Math.max(
    0,
    ...resolved
      .flat()
      .map((r) => textWidth(rowLine(r.name, r.note), BAND_NAME_SIZE))
  );
  const chipX = x0 + nameW + BAND_CHIP_GAP;
  const chains = (chips: readonly string[]) => {
    let x = chipX;
    return chips.map((text) => {
      const c = { text, x, width: chipWidth(text) };
      x += c.width + BAND_CHIP_LINK;
      return c;
    });
  };
  const chainEnd = Math.max(
    chipX,
    ...resolved
      .flat()
      .flatMap((r) => chains(r.chips))
      .map((c) => c.x + c.width)
  );
  const m = spec.meter;
  const kinds: readonly string[] = m
    ? typeof m.marker === "string"
      ? [m.marker]
      : m.marker
    : [];
  const timesOf = (d: BandInput) =>
    m
      ? d.markers
          .filter((k) => kinds.includes(k.kind))
          .map((k) => k.t)
          .sort((a, b) => a - b)
      : [];
  const totals = inputs.map((d) => timesOf(d).length);
  const footnote =
    m?.footnote ??
    (m && inputs.length > 1
      ? inputs.map((d, i) => `${d.arrangement}: ${totals[i]}`).join("  ·  ")
      : undefined);
  const meterW = m ? meterWidth(m.label, Math.max(0, ...totals), footnote) : 0;
  const meterX = m
    ? Math.max(chainEnd + BAND_METER_GAP, content.x1 - meterW)
    : chainEnd;
  const right = Math.max(content.x1, m ? meterX + meterW : chainEnd);
  const lastRow = firstRow + (spec.rows.length - 1) * BAND_ROW_STEP;
  const ringsY = firstRow + BAND_ROW_STEP;
  const footnoteY = ringsY + BAND_ROW_STEP;
  const bottom = Math.max(
    lastRow + BAND_CHIP_HEIGHT / 2,
    m
      ? footnote
        ? footnoteY + (BAND_FOOTNOTE_SIZE * LINE_EM) / 2
        : ringsY + BAND_METER_RING
      : 0
  );
  return inputs.map((d, i) => ({
    x0,
    x1: right,
    y,
    ...(spec.heading ? { heading: spec.heading } : {}),
    headingY: y + BAND_HEADING_DY,
    chipX,
    rows: spec.rows.map((r, k) => {
      const { note, chips } = resolved[i][k];
      return {
        name: r.name,
        ...(note ? { note } : {}),
        y: firstRow + k * BAND_ROW_STEP,
        chips: chains(chips),
        windows: r.beats.flatMap((b) => {
          const w = d.windows.get(b);
          return w && w[1] > w[0] ? [w] : [];
        }),
      };
    }),
    ...(m
      ? {
          meter: {
            label: m.label,
            markers: kinds,
            x: meterX,
            labelY: firstRow,
            ringsY,
            footnoteY,
            times: timesOf(d),
            ...(footnote ? { footnote } : {}),
          },
        }
      : {}),
    y1: bottom + BAND_PAD,
  }));
}
