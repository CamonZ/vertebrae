/**
 * Keyboard line cursor over parsed diff files. On a line, the cursor is the
 * end point of the shared diff line selection (`SelectedLineRange`), so the
 * keyboard and the mouse drive one selection model. It can also rest on a
 * collapsed gap of unchanged lines, which ↵ reveals (see `diffGaps`). This
 * module only computes the next cursor.
 *
 * No React or Pierre runtime imports: it reads `FilePatch` rows.
 */
import type { SelectedLineRange, SelectionSide } from "@pierre/diffs";
import { canonicalPath, type FilePatch, type HunkRow } from "./diffLineMapper";
import { fileRows, type FileContext } from "./diffGaps";

export type DiffLayout = "unified" | "split";

/** How a surface shows its files: the layout and, where lines can be revealed, each file's gaps. */
export interface CursorView {
  layout: DiffLayout;
  /** Gap state for a file; without it the file's gaps are not rows. */
  context?(path: string): FileContext | undefined;
}

/** Marks the element that owns the keyboard line cursor. */
export const DIFF_CURSOR_HOST_ATTRIBUTE = "data-diff-cursor-host";

/** Marks an element (a file heading) where ↓ starts the cursor in `path`. */
export const DIFF_CURSOR_ENTRY_ATTRIBUTE = "data-diff-cursor-entry";

/** One line the cursor can rest on. */
export interface CursorPoint {
  side: SelectionSide;
  line: number;
}

/** The cursor on lines: the selection's end is where it rests. */
export interface LineCursor {
  kind: "line";
  path: string;
  range: SelectedLineRange;
}

/** The cursor on a collapsed gap of unchanged lines. */
export interface GapCursor {
  kind: "gap";
  path: string;
  /** The gap above hunk `gap`; `hunks.length` is the gap below the last hunk. */
  gap: number;
  /** How the cursor arrived: 1 moving down (from above), -1 moving up. */
  arrival: -1 | 1;
  /** The column the cursor continues on in a split diff. */
  side: SelectionSide;
}

export type DiffCursor = LineCursor | GapCursor;

function lineOn(row: HunkRow, side: SelectionSide): number | null {
  return side === "deletions" ? row.oldLine : row.newLine;
}

/** The point a unified diff shows for a row: removed rows sit on deletions. */
function unifiedPoint(row: HunkRow): CursorPoint | null {
  if (row.kind === "del") {
    return row.oldLine === null ? null : { side: "deletions", line: row.oldLine };
  }
  return row.newLine === null ? null : { side: "additions", line: row.newLine };
}

type Stop =
  | {
      kind: "line";
      point: CursorPoint;
      row: HunkRow;
      /** Patch hunk; null for a revealed unchanged line. */
      hunk: number | null;
    }
  | { kind: "gap"; gap: number };

type LineStop = Extract<Stop, { kind: "line" }>;

const isLine = (stop: Stop | undefined): stop is LineStop => stop?.kind === "line";

/**
 * Rows in display order. A unified diff visits every row; a split diff visits
 * the rows that have a number on the cursor's column. Gaps span both columns.
 */
function stops(file: FilePatch, view: CursorView, side: SelectionSide): Stop[] {
  const context = view.context?.(canonicalPath(file));
  return fileRows(file, context).flatMap((entry): Stop[] => {
    if (entry.kind === "gap") return [{ kind: "gap", gap: entry.gap }];
    const { row, hunk } = entry;
    if (view.layout === "unified") {
      const point = unifiedPoint(row);
      return point ? [{ kind: "line", point, row, hunk }] : [];
    }
    const line = lineOn(row, side);
    return line === null ? [] : [{ kind: "line", point: { side, line }, row, hunk }];
  });
}

function samePoint(a: CursorPoint, b: CursorPoint): boolean {
  return a.side === b.side && a.line === b.line;
}

function indexOf(list: readonly Stop[], point: CursorPoint): number {
  const exact = list.findIndex(
    (stop) => isLine(stop) && samePoint(stop.point, point)
  );
  if (exact >= 0) return exact;
  // A mouse selection may sit on a column this layout does not walk (a
  // context row selected on the deletions side of a unified diff).
  return list.findIndex(
    (stop) => isLine(stop) && lineOn(stop.row, point.side) === point.line
  );
}

function rangeEnd(range: SelectedLineRange): CursorPoint {
  return { side: range.endSide ?? range.side ?? "additions", line: range.end };
}

function rangeStart(range: SelectedLineRange): CursorPoint {
  return { side: range.side ?? "additions", line: range.start };
}

function rangeBetween(start: CursorPoint, end: CursorPoint): SelectedLineRange {
  return {
    start: start.line,
    side: start.side,
    end: end.line,
    ...(end.side === start.side ? {} : { endSide: end.side }),
  };
}

/** The single-line cursor on `point`. */
export function lineCursor(path: string, point: CursorPoint): LineCursor {
  return { kind: "line", path, range: rangeBetween(point, point) };
}

/** The column the cursor walks. */
export function cursorSide(cursor: DiffCursor): SelectionSide {
  return cursor.kind === "gap" ? cursor.side : rangeEnd(cursor.range).side;
}

/**
 * Where the cursor is in `list`: an exact index, or (for a gap that has since
 * closed) the index of the first row after where it was.
 */
function locate(
  list: readonly Stop[],
  cursor: DiffCursor
): { index: number; exact: boolean } {
  if (cursor.kind === "line") {
    const index = indexOf(list, rangeEnd(cursor.range));
    return { index, exact: index >= 0 };
  }
  const index = list.findIndex(
    (stop) => stop.kind === "gap" && stop.gap === cursor.gap
  );
  if (index >= 0) return { index, exact: true };
  const after = list.findIndex(
    (stop) => isLine(stop) && stop.hunk !== null && stop.hunk >= cursor.gap
  );
  return { index: after < 0 ? list.length : after, exact: false };
}

function cursorAt(
  path: string,
  stop: Stop,
  arrival: -1 | 1,
  side: SelectionSide
): DiffCursor {
  return stop.kind === "gap"
    ? { kind: "gap", path, gap: stop.gap, arrival, side }
    : lineCursor(path, stop.point);
}

/**
 * The cursor after ↑/↓. Without `extend` the cursor moves one row (a line or
 * a gap) and crosses into the neighbouring file at either end; with `extend`
 * the line range grows from its anchor and stops at a gap or the file's
 * edge, because a selection is contiguous lines of one file. Null when there
 * is no row to move to.
 */
export function moveCursor(
  files: readonly FilePatch[],
  view: CursorView,
  current: DiffCursor | null,
  direction: -1 | 1,
  extend: boolean
): DiffCursor | null {
  const fileIndex = current
    ? files.findIndex((file) => canonicalPath(file) === current.path)
    : -1;
  if (!current || fileIndex < 0) {
    const ordered = direction === 1 ? files : [...files].reverse();
    for (const file of ordered) {
      const list = stops(file, view, "additions");
      const stop = direction === 1 ? list[0] : list[list.length - 1];
      if (stop) return cursorAt(canonicalPath(file), stop, direction, "additions");
    }
    return null;
  }

  const side = cursorSide(current);
  const list = stops(files[fileIndex], view, side);
  const { index, exact } = locate(list, current);
  const next =
    index < 0
      ? list[0]
      : list[exact ? index + direction : direction === 1 ? index : index - 1];
  if (next) {
    if (!extend) return cursorAt(current.path, next, direction, side);
    if (current.kind !== "line" || !isLine(next)) return current;
    return {
      kind: "line",
      path: current.path,
      range: rangeBetween(rangeStart(current.range), next.point),
    };
  }
  if (extend) return current;

  for (
    let other = fileIndex + direction;
    other >= 0 && other < files.length;
    other += direction
  ) {
    const neighbour = stops(files[other], view, side);
    const stop = direction === 1 ? neighbour[0] : neighbour[neighbour.length - 1];
    if (stop) return cursorAt(canonicalPath(files[other]), stop, direction, side);
  }
  return current;
}

/**
 * The line nearest a gap, for scrolling it into view: the first line after
 * it, else the last line before it. Null when the file has no lines.
 */
export function gapScrollPoint(
  files: readonly FilePatch[],
  view: CursorView,
  cursor: GapCursor
): CursorPoint | null {
  const file = files.find((candidate) => canonicalPath(candidate) === cursor.path);
  if (!file) return null;
  const list = stops(file, view, cursor.side);
  const { index } = locate(list, cursor);
  const after = list.slice(index + 1).find(isLine);
  const before = list.slice(0, Math.max(index, 0)).reverse().find(isLine);
  return (after ?? before)?.point ?? null;
}

interface SplitRow {
  deletions: number | null;
  additions: number | null;
}

/**
 * Rows as a split diff shows them: context on both columns, and within each
 * run of changes the k-th removed line beside the k-th added line.
 */
function splitRows(file: FilePatch, view: CursorView): SplitRow[] {
  const result: SplitRow[] = [];
  let removed: number[] = [];
  let added: number[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      result.push({ deletions: removed[k] ?? null, additions: added[k] ?? null });
    }
    removed = [];
    added = [];
  };
  for (const entry of fileRows(file, view.context?.(canonicalPath(file)))) {
    if (entry.kind === "gap") {
      flush();
      continue;
    }
    const row = entry.row;
    if (row.kind === "del" && row.oldLine !== null) {
      if (added.length) flush();
      removed.push(row.oldLine);
    } else if (row.kind === "add" && row.newLine !== null) {
      added.push(row.newLine);
    } else {
      flush();
      result.push({ deletions: row.oldLine, additions: row.newLine });
    }
  }
  flush();
  return result;
}

/**
 * The cursor after ←/→ in a split diff: it moves to the same row on the other
 * column, or the nearest row (above first) that has a line there. A unified
 * diff has one column, so the cursor is unchanged.
 */
export function switchCursorSide(
  files: readonly FilePatch[],
  view: CursorView,
  current: LineCursor,
  side: SelectionSide
): LineCursor {
  const end = rangeEnd(current.range);
  if (view.layout === "unified" || end.side === side) return current;
  const file = files.find((candidate) => canonicalPath(candidate) === current.path);
  if (!file) return current;
  const rows = splitRows(file, view);
  const at = rows.findIndex((row) => row[end.side] === end.line);
  if (at < 0) return current;
  for (let distance = 0; distance < rows.length; distance++) {
    for (const index of [at - distance, at + distance]) {
      const line = rows[index]?.[side];
      if (line != null) return lineCursor(current.path, { side, line });
    }
  }
  return current;
}

/**
 * The code shown between the selection's ends, in display order, without
 * diff markers or line numbers. Null when an end is not a line of the layout
 * (callers fall back to the resolved selection snapshot).
 */
export function selectedCode(
  file: FilePatch,
  view: CursorView,
  range: SelectedLineRange
): string | null {
  const start = rangeStart(range);
  const end = rangeEnd(range);
  if (view.layout === "split" && start.side !== end.side) return null;
  const list = stops(file, view, end.side);
  const from = indexOf(list, start);
  const to = indexOf(list, end);
  if (from < 0 || to < 0) return null;
  return list
    .slice(Math.min(from, to), Math.max(from, to) + 1)
    .filter(isLine)
    .map((stop) => stop.row.text)
    .join("\n");
}

/**
 * The cursor after ⌥↑/⌥↓: it jumps to the previous or next landmark across
 * files. Landmarks are each hunk's first line plus `marks` (lines carrying
 * comments or discussions); with `filesOnly`, only each file's first line.
 * Null when there is none in that direction.
 */
export function moveToLandmark(
  files: readonly FilePatch[],
  view: CursorView,
  current: DiffCursor | null,
  direction: -1 | 1,
  options: {
    filesOnly?: boolean;
    marks?(path: string): readonly CursorPoint[];
  } = {}
): LineCursor | null {
  const side = current ? cursorSide(current) : "additions";
  const landmarks = files.flatMap((file, fileIndex) => {
    const list = stops(file, view, side);
    const indexes = new Set<number>();
    const seenHunks = new Set<number>();
    list.forEach((stop, index) => {
      if (!isLine(stop)) return;
      if (options.filesOnly) {
        if (indexes.size === 0) indexes.add(index);
        return;
      }
      if (stop.hunk !== null && !seenHunks.has(stop.hunk)) {
        seenHunks.add(stop.hunk);
        indexes.add(index);
      }
    });
    if (!options.filesOnly) {
      for (const mark of options.marks?.(canonicalPath(file)) ?? []) {
        const index = indexOf(list, mark);
        if (index >= 0) indexes.add(index);
      }
    }
    return [...indexes]
      .sort((a, b) => a - b)
      .flatMap((index) => {
        const stop = list[index];
        return isLine(stop) ? [{ fileIndex, index, point: stop.point, file }] : [];
      });
  });

  let position: [number, number] = direction === 1 ? [-1, -1] : [files.length, 0];
  if (current) {
    const fileIndex = files.findIndex((file) => canonicalPath(file) === current.path);
    if (fileIndex >= 0) {
      const list = stops(files[fileIndex], view, side);
      const { index, exact } = locate(list, current);
      // A closed gap sits just before the row now at its index.
      position = [fileIndex, exact ? index : index - 0.5];
    }
  }
  const compare = (mark: { fileIndex: number; index: number }) =>
    mark.fileIndex - position[0] || mark.index - position[1];
  const target =
    direction === 1
      ? landmarks.find((mark) => compare(mark) > 0)
      : [...landmarks].reverse().find((mark) => compare(mark) < 0);
  if (!target) return null;
  return lineCursor(canonicalPath(target.file), target.point);
}
