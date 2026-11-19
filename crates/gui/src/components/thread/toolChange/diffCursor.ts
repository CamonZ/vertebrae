/**
 * Keyboard line cursor over parsed diff files. The cursor is the end point of
 * the shared diff line selection (`SelectedLineRange`), so the keyboard and the
 * mouse drive one selection model; this module only computes the next range.
 *
 * No React or Pierre runtime imports: it reads `FilePatch` rows.
 */
import type { SelectedLineRange, SelectionSide } from "@pierre/diffs";
import { canonicalPath, type FilePatch, type HunkRow } from "./diffLineMapper";

export type DiffLayout = "unified" | "split";

/** Marks the element that owns the keyboard line cursor. */
export const DIFF_CURSOR_HOST_ATTRIBUTE = "data-diff-cursor-host";

/** Marks an element (a file heading) where ↓ starts the cursor in `path`. */
export const DIFF_CURSOR_ENTRY_ATTRIBUTE = "data-diff-cursor-entry";

/** One line the cursor can rest on. */
export interface CursorPoint {
  side: SelectionSide;
  line: number;
}

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

interface Stop {
  point: CursorPoint;
  row: HunkRow;
  hunk: number;
}

/**
 * Lines in display order. A unified diff visits every row; a split diff visits
 * the rows that have a number on the cursor's column.
 */
function stops(file: FilePatch, layout: DiffLayout, side: SelectionSide): Stop[] {
  return file.hunks.flatMap((hunk, index) =>
    hunk.rows.flatMap((row) => {
      if (layout === "unified") {
        const point = unifiedPoint(row);
        return point ? [{ point, row, hunk: index }] : [];
      }
      const line = lineOn(row, side);
      return line === null ? [] : [{ point: { side, line }, row, hunk: index }];
    })
  );
}

function samePoint(a: CursorPoint, b: CursorPoint): boolean {
  return a.side === b.side && a.line === b.line;
}

function indexOf(list: readonly Stop[], point: CursorPoint): number {
  const exact = list.findIndex((stop) => samePoint(stop.point, point));
  if (exact >= 0) return exact;
  // A mouse selection may sit on a column this layout does not walk (a
  // context row selected on the deletions side of a unified diff).
  return list.findIndex((stop) => {
    const row = stop.row;
    return lineOn(row, point.side) === point.line;
  });
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

export interface CursorSelection {
  path: string;
  range: SelectedLineRange;
}

/**
 * The selection after ↑/↓. Without `extend` the cursor collapses to one line
 * and crosses into the neighbouring file at either end; with `extend` the
 * range grows from its anchor and stops at the file's edge, because a
 * selection belongs to one file. Null when there is no line to move to.
 */
export function moveCursor(
  files: readonly FilePatch[],
  layout: DiffLayout,
  current: CursorSelection | null,
  direction: -1 | 1,
  extend: boolean
): CursorSelection | null {
  const fileIndex = current
    ? files.findIndex((file) => canonicalPath(file) === current.path)
    : -1;
  if (!current || fileIndex < 0) {
    const ordered = direction === 1 ? files : [...files].reverse();
    for (const file of ordered) {
      const list = stops(file, layout, "additions");
      const stop = direction === 1 ? list[0] : list[list.length - 1];
      if (stop) return { path: canonicalPath(file), range: rangeBetween(stop.point, stop.point) };
    }
    return null;
  }

  const end = rangeEnd(current.range);
  const file = files[fileIndex];
  const list = stops(file, layout, end.side);
  const index = indexOf(list, end);
  const next = list[index < 0 ? 0 : index + direction];
  if (next) {
    const start = extend ? rangeStart(current.range) : next.point;
    return { path: current.path, range: rangeBetween(start, next.point) };
  }
  if (extend) return current;

  for (
    let other = fileIndex + direction;
    other >= 0 && other < files.length;
    other += direction
  ) {
    const neighbour = stops(files[other], layout, end.side);
    const stop = direction === 1 ? neighbour[0] : neighbour[neighbour.length - 1];
    if (stop) {
      return {
        path: canonicalPath(files[other]),
        range: rangeBetween(stop.point, stop.point),
      };
    }
  }
  return current;
}

interface SplitRow {
  deletions: number | null;
  additions: number | null;
}

/**
 * Rows as a split diff shows them: context on both columns, and within each
 * run of changes the k-th removed line beside the k-th added line.
 */
function splitRows(file: FilePatch): SplitRow[] {
  const result: SplitRow[] = [];
  for (const hunk of file.hunks) {
    let removed: number[] = [];
    let added: number[] = [];
    const flush = () => {
      for (let k = 0; k < Math.max(removed.length, added.length); k++) {
        result.push({ deletions: removed[k] ?? null, additions: added[k] ?? null });
      }
      removed = [];
      added = [];
    };
    for (const row of hunk.rows) {
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
  }
  return result;
}

/**
 * The selection after ←/→ in a split diff: the cursor moves to the same row on
 * the other column, or the nearest row (above first) that has a line there. A
 * unified diff has one column, so the selection is unchanged.
 */
export function switchCursorSide(
  files: readonly FilePatch[],
  layout: DiffLayout,
  current: CursorSelection,
  side: SelectionSide
): CursorSelection {
  const end = rangeEnd(current.range);
  if (layout === "unified" || end.side === side) return current;
  const file = files.find((candidate) => canonicalPath(candidate) === current.path);
  if (!file) return current;
  const rows = splitRows(file);
  const at = rows.findIndex((row) => row[end.side] === end.line);
  if (at < 0) return current;
  for (let distance = 0; distance < rows.length; distance++) {
    for (const index of [at - distance, at + distance]) {
      const line = rows[index]?.[side];
      if (line != null) {
        const point = { side, line };
        return { path: current.path, range: rangeBetween(point, point) };
      }
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
  layout: DiffLayout,
  range: SelectedLineRange
): string | null {
  const start = rangeStart(range);
  const end = rangeEnd(range);
  if (layout === "split" && start.side !== end.side) return null;
  const list = stops(file, layout, end.side);
  const from = indexOf(list, start);
  const to = indexOf(list, end);
  if (from < 0 || to < 0) return null;
  return list
    .slice(Math.min(from, to), Math.max(from, to) + 1)
    .map((stop) => stop.row.text)
    .join("\n");
}

/**
 * The selection after ⌥↑/⌥↓: the cursor jumps to the previous or next
 * landmark across files. Landmarks are each hunk's first line plus `marks`
 * (lines carrying comments or discussions); with `filesOnly`, only each file's
 * first line. Null when there is none in that direction.
 */
export function moveToLandmark(
  files: readonly FilePatch[],
  layout: DiffLayout,
  current: CursorSelection | null,
  direction: -1 | 1,
  options: {
    filesOnly?: boolean;
    marks?(path: string): readonly CursorPoint[];
  } = {}
): CursorSelection | null {
  const side = current ? rangeEnd(current.range).side : "additions";
  const landmarks = files.flatMap((file, fileIndex) => {
    const list = stops(file, layout, side);
    const indexes = new Set<number>();
    list.forEach((stop, index) => {
      if (index === 0 || (!options.filesOnly && stop.hunk !== list[index - 1].hunk))
        indexes.add(index);
    });
    if (!options.filesOnly) {
      for (const mark of options.marks?.(canonicalPath(file)) ?? []) {
        const index = indexOf(list, mark);
        if (index >= 0) indexes.add(index);
      }
    }
    return [...indexes]
      .sort((a, b) => a - b)
      .map((index) => ({ fileIndex, index, point: list[index].point, file }));
  });

  let position: [number, number] = direction === 1 ? [-1, -1] : [files.length, 0];
  if (current) {
    const fileIndex = files.findIndex((file) => canonicalPath(file) === current.path);
    if (fileIndex >= 0) {
      const list = stops(files[fileIndex], layout, side);
      position = [fileIndex, indexOf(list, rangeEnd(current.range))];
    }
  }
  const compare = (mark: { fileIndex: number; index: number }) =>
    mark.fileIndex - position[0] || mark.index - position[1];
  const target =
    direction === 1
      ? landmarks.find((mark) => compare(mark) > 0)
      : [...landmarks].reverse().find((mark) => compare(mark) < 0);
  if (!target) return null;
  return {
    path: canonicalPath(target.file),
    range: rangeBetween(target.point, target.point),
  };
}
