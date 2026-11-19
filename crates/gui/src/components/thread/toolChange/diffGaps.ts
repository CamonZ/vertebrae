/**
 * Collapsed unchanged lines between, above and below a file's hunks, and the
 * rows a diff shows once some of them are revealed. Mirrors how Pierre lays
 * out a `line-info` diff so the keyboard cursor walks the same rows:
 *
 * - gap `i` sits above hunk `i`; gap `hunks.length` sits below the last hunk
 *   and is only known once the full file is loaded;
 * - a gap reveals lines at its top (below the hunk above, Pierre `fromStart`)
 *   and at its bottom (above the hunk below, Pierre `fromEnd`);
 * - before the file is loaded every gap stays collapsed; once loaded, gaps no
 *   longer than {@link COLLAPSED_CONTEXT_THRESHOLD} are shown in full.
 *
 * No React or Pierre runtime imports.
 */
import type { FilePatch, HunkRow } from "./diffLineMapper";

/** Pierre's default `collapsedContextThreshold`. */
export const COLLAPSED_CONTEXT_THRESHOLD = 1;

/** Lines revealed by one ↵ on a gap (and by Pierre's expand buttons). */
export const GAP_BATCH = 20;

/** Lines revealed at each end of one gap. */
export interface GapReveal {
  /** Shown below the hunk above. */
  top: number;
  /** Shown above the hunk below. */
  bottom: number;
}

/** What a diff surface knows about one file beyond its patch. */
export interface FileContext {
  /** Revealed lines per gap index. */
  revealed: ReadonlyMap<number, GapReveal>;
  /**
   * The new file's lines once loaded (gaps can be revealed and the gap below
   * the last hunk exists); null while only the patch is known.
   */
  lines: readonly string[] | null;
}

export type GapEnd = "top" | "bottom";

interface Gap {
  index: number;
  /** First old/new line inside the gap. */
  oldStart: number;
  newStart: number;
  size: number;
}

/** Lines that precede a hunk on one side (`@@ -5,0` sits after line 5). */
const linesBefore = (start: number, count: number) =>
  count === 0 ? start : start - 1;

function fileGaps(file: FilePatch, lineCount: number | null): Gap[] {
  const gaps: Gap[] = [];
  let oldEnd = 0;
  let newEnd = 0;
  file.hunks.forEach((hunk, index) => {
    const size = linesBefore(hunk.newStart, hunk.newCount) - newEnd;
    if (size > 0)
      gaps.push({ index, oldStart: oldEnd + 1, newStart: newEnd + 1, size });
    oldEnd = linesBefore(hunk.oldStart, hunk.oldCount) + hunk.oldCount;
    newEnd = linesBefore(hunk.newStart, hunk.newCount) + hunk.newCount;
  });
  if (lineCount !== null && file.hunks.length > 0 && lineCount > newEnd) {
    gaps.push({
      index: file.hunks.length,
      oldStart: oldEnd + 1,
      newStart: newEnd + 1,
      size: lineCount - newEnd,
    });
  }
  return gaps;
}

/**
 * The end ↵ reveals for a cursor that arrived moving `arrival` (the end next
 * to the hunk it came from) and the end ⌥↵ reveals. The gap above the first
 * hunk only grows from its bottom and the gap below the last only from its
 * top, so those have no other end.
 */
export function gapEnds(
  file: FilePatch,
  gap: number,
  arrival: -1 | 1
): { primary: GapEnd; other: GapEnd | null } {
  const ends: GapEnd[] = [];
  if (gap > 0) ends.push("top");
  if (gap < file.hunks.length) ends.push("bottom");
  const near: GapEnd = arrival === 1 ? "top" : "bottom";
  const primary = ends.includes(near) ? near : ends[0];
  return { primary, other: ends.find((end) => end !== primary) ?? null };
}

interface Shown {
  top: number;
  bottom: number;
  hidden: number;
}

function shown(file: FilePatch, gap: Gap, context: FileContext): Shown {
  if (context.lines === null) return { top: 0, bottom: 0, hidden: gap.size };
  if (gap.size <= COLLAPSED_CONTEXT_THRESHOLD)
    return { top: gap.size, bottom: 0, hidden: 0 };
  const reveal = context.revealed.get(gap.index);
  const clamp = (value: number | undefined) =>
    Math.min(Math.max(value ?? 0, 0), gap.size);
  const top = clamp(reveal?.top);
  // The gap below the last hunk only grows from its top.
  const bottom = gap.index === file.hunks.length ? 0 : clamp(reveal?.bottom);
  if (top + bottom >= gap.size) return { top: gap.size, bottom: 0, hidden: 0 };
  return { top, bottom, hidden: gap.size - top - bottom };
}

/** One row as the diff shows it. */
export type DiffRow =
  | {
      kind: "line";
      row: HunkRow;
      /** The patch hunk the row belongs to; null for a revealed line. */
      hunk: number | null;
    }
  | { kind: "gap"; gap: number; hidden: number };

function revealedRow(
  gap: Gap,
  offset: number,
  lines: readonly string[] | null
): DiffRow {
  const newLine = gap.newStart + offset;
  return {
    kind: "line",
    hunk: null,
    row: {
      kind: "context",
      text: (lines?.[newLine - 1] ?? "").replace(/\r?\n$/, ""),
      oldLine: gap.oldStart + offset,
      newLine,
      noNewline: false,
    },
  };
}

/**
 * A file's rows in display order. Without a context only the patch's rows
 * exist: surfaces that cannot reveal lines have no gap rows.
 */
export function fileRows(file: FilePatch, context?: FileContext): DiffRow[] {
  const hunkRows = (index: number): DiffRow[] =>
    file.hunks[index].rows.map((row) => ({ kind: "line", row, hunk: index }));
  if (!context) return file.hunks.flatMap((_, index) => hunkRows(index));

  const gaps = new Map(
    fileGaps(file, context.lines?.length ?? null).map((gap) => [gap.index, gap])
  );
  const rows: DiffRow[] = [];
  for (let index = 0; index <= file.hunks.length; index++) {
    const gap = gaps.get(index);
    if (gap) {
      const { top, bottom, hidden } = shown(file, gap, context);
      for (let offset = 0; offset < top; offset++)
        rows.push(revealedRow(gap, offset, context.lines));
      if (hidden > 0) rows.push({ kind: "gap", gap: index, hidden });
      for (let offset = gap.size - bottom; offset < gap.size; offset++)
        rows.push(revealedRow(gap, offset, context.lines));
    }
    if (index < file.hunks.length) rows.push(...hunkRows(index));
  }
  return rows;
}

/** A gap's hidden line count, or 0 when it is not collapsed. */
export function hiddenLines(
  file: FilePatch,
  context: FileContext,
  gap: number
): number {
  const found = fileGaps(file, context.lines?.length ?? null).find(
    (candidate) => candidate.index === gap
  );
  return found ? shown(file, found, context).hidden : 0;
}

export type GapReach = "batch" | "other";

export interface GapRevealResult {
  /** The gap's reveal after this step (always within the gap's size). */
  reveal: GapReveal;
  /** Lines still hidden afterwards. */
  hidden: number;
  /**
   * The revealed line for the cursor: beside what stays hidden, or once the
   * gap closes, the first new line next to where the cursor was.
   */
  landing: { oldLine: number; newLine: number };
}

/**
 * Reveal one section (`batch` lines) of a collapsed gap. The cursor arrived
 * moving `arrival` (1 = down, from the hunk above): `batch` reveals the
 * lines next to that hunk, `other` the opposite end. A gap with one usable
 * end (above the first hunk, below the last) always reveals that end. Null
 * when the gap is not collapsed or the file is not loaded.
 */
export function revealGap(
  file: FilePatch,
  context: FileContext,
  gap: number,
  arrival: -1 | 1,
  reach: GapReach,
  batch = GAP_BATCH
): GapRevealResult | null {
  if (context.lines === null) return null;
  const found = fileGaps(file, context.lines.length).find(
    (candidate) => candidate.index === gap
  );
  if (!found) return null;
  const before = shown(file, found, context);
  if (before.hidden === 0) return null;

  const ends = gapEnds(file, gap, arrival);
  const end = reach === "other" ? (ends.other ?? ends.primary) : ends.primary;
  const count = Math.min(batch, before.hidden);

  const reveal: GapReveal = { top: before.top, bottom: before.bottom };
  reveal[end] += count;
  const hidden = before.hidden - count;
  // Beside what stays hidden, so ↵ again continues there; once the gap
  // closes, the first new line next to where the cursor was.
  const offset =
    hidden > 0
      ? end === "top"
        ? reveal.top - 1
        : found.size - reveal.bottom
      : arrival === 1
        ? before.top
        : found.size - before.bottom - 1;
  return {
    reveal,
    hidden,
    landing: {
      oldLine: found.oldStart + offset,
      newLine: found.newStart + offset,
    },
  };
}

/**
 * A gap after one of Pierre's expand controls reveals a section of at most
 * `count` lines at `ends` (split between both ends for its two-way control;
 * ends the gap lacks are skipped). Null when the gap is not collapsed or the
 * file is not loaded.
 */
export function growGap(
  file: FilePatch,
  context: FileContext,
  gap: number,
  ends: readonly GapEnd[],
  count: number
): GapReveal | null {
  if (context.lines === null) return null;
  const found = fileGaps(file, context.lines.length).find(
    (candidate) => candidate.index === gap
  );
  if (!found) return null;
  const before = shown(file, found, context);
  if (before.hidden === 0) return null;
  const usable = ends.filter((end) =>
    end === "top" ? gap > 0 : gap < file.hunks.length
  );
  if (usable.length === 0) return null;
  const total = Math.min(count, before.hidden);
  const reveal: GapReveal = { top: before.top, bottom: before.bottom };
  usable.forEach((end, index) => {
    // The first end takes the odd line of a split section.
    reveal[end] += index === 0 ? Math.ceil(total / usable.length) : Math.floor(total / usable.length);
  });
  return reveal;
}
