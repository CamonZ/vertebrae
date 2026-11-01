/**
 * Pure unified-diff line mapping for review comments.
 *
 * A worktree is described by an ordered chain of tool-call patches
 * (`T1..Tn`, each old -> new) and by the All Changes patch (`A`, baseline ->
 * working tree). A comment sits on one line of one patch; this module finds
 * the same line on the other patches by hunk-offset arithmetic. Lines above a
 * hunk keep their number, lines below shift by (added - removed), context lines
 * inside a hunk are mappable and changed lines map only to the patch that
 * changed them. Renames follow `oldPath -> newPath` across the chain.
 *
 * No React or Pierre imports: this module only reads patch text.
 */

export type DiffSide = "old" | "new";
export type HunkRowKind = "context" | "add" | "del";

export interface HunkRow {
  kind: HunkRowKind;
  /** Line content without the diff prefix. */
  text: string;
  /** Number on the old side; null for added rows. */
  oldLine: number | null;
  /** Number on the new side; null for deleted rows. */
  newLine: number | null;
  /** The row is followed by a "\ No newline at end of file" marker. */
  noNewline: boolean;
}

export interface Hunk {
  /** The `@@ ... @@` header line exactly as written in the patch. */
  header: string;
  oldStart: number;
  newStart: number;
  /** Old-side line count, counted from the rows. */
  oldCount: number;
  /** New-side line count, counted from the rows. */
  newCount: number;
  rows: HunkRow[];
}

export interface FilePatch {
  /** Path before the change; null when the file is added. */
  oldPath: string | null;
  /** Path after the change; null when the file is deleted. */
  newPath: string | null;
  hunks: Hunk[];
}

/** The path a file is known by in review: new path, else old path. */
export function canonicalPath(file: FilePatch): string {
  return file.newPath ?? file.oldPath ?? "";
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquotePath(raw: string): string {
  const text = raw.trim();
  if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"'))) {
    return text;
  }
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const inner = text.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      bytes.push(...encoder.encode(ch));
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1))![0];
      bytes.push(parseInt(octal, 8));
      i += octal.length;
      continue;
    }
    const escapes: Record<string, string> = {
      t: "\t",
      n: "\n",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    bytes.push(...encoder.encode(escapes[next] ?? next));
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** `a/x` or `b/x` or `/dev/null` from a `---`/`+++` line operand. */
function headerPath(raw: string, prefix: "a/" | "b/"): string | null {
  // A tab may precede a timestamp in non-Git unified diffs.
  const operand = unquotePath(raw.split("\t")[0]);
  if (operand === "/dev/null") return null;
  return operand.startsWith(prefix) ? operand.slice(prefix.length) : operand;
}

function gitHeaderPaths(rest: string): { oldPath: string; newPath: string } {
  if (rest.startsWith('"') || rest.includes(' "')) {
    const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|.+)$/.exec(
      rest
    );
    if (quoted) {
      return {
        oldPath: headerPath(quoted[1], "a/") ?? "",
        newPath: headerPath(quoted[2], "b/") ?? "",
      };
    }
  }
  // Unquoted: `a/X b/X` is symmetric for the common non-rename case.
  const half = (rest.length - 3) / 2;
  if (Number.isInteger(half) && half > 0) {
    const left = rest.slice(0, half + 2);
    const right = rest.slice(half + 3);
    if (
      left.startsWith("a/") &&
      right.startsWith("b/") &&
      left.slice(2) === right.slice(2)
    ) {
      return { oldPath: left.slice(2), newPath: right.slice(2) };
    }
  }
  const split = /^a\/(.+) b\/(.+)$/.exec(rest);
  return split
    ? { oldPath: split[1], newPath: split[2] }
    : { oldPath: rest, newPath: rest };
}

/** Parse a unified (Git-format) patch into per-file hunks. */
export function parsePatch(patch: string): FilePatch[] {
  const lines = patch.split("\n");
  const files: FilePatch[] = [];
  let current: FilePatch | null = null;
  // Whether `current` has seen its `---` line, so a second one starts a file.
  let sawOldHeader = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const { oldPath, newPath } = gitHeaderPaths(line.slice(11));
      current = { oldPath, newPath, hunks: [] };
      files.push(current);
      sawOldHeader = false;
      i++;
      continue;
    }
    if (current && !sawOldHeader && line.startsWith("rename from ")) {
      current.oldPath = unquotePath(line.slice(12));
      i++;
      continue;
    }
    if (current && !sawOldHeader && line.startsWith("rename to ")) {
      current.newPath = unquotePath(line.slice(10));
      i++;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (!current || sawOldHeader || current.hunks.length > 0) {
        current = { oldPath: null, newPath: null, hunks: [] };
        files.push(current);
      }
      sawOldHeader = true;
      current.oldPath = headerPath(line.slice(4), "a/");
      i++;
      continue;
    }
    if (current && line.startsWith("+++ ")) {
      current.newPath = headerPath(line.slice(4), "b/");
      i++;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (!current || !header) {
      i++;
      continue;
    }

    const oldStart = Number(header[1]);
    const newStart = Number(header[3]);
    let oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
    let newRemaining = header[4] === undefined ? 1 : Number(header[4]);
    const hunk: Hunk = {
      header: line,
      oldStart,
      newStart,
      oldCount: 0,
      newCount: 0,
      rows: [],
    };
    let oldLine = oldStart;
    let newLine = newStart;
    // A zero-length range names the line *before* the gap.
    if (oldRemaining === 0) oldLine += 1;
    if (newRemaining === 0) newLine += 1;
    i++;
    while (i < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
      const body = lines[i];
      const sign = body[0];
      if (sign === "\\") {
        const last = hunk.rows[hunk.rows.length - 1];
        if (last) last.noNewline = true;
        i++;
        continue;
      }
      let kind: HunkRowKind;
      if (sign === "+") kind = "add";
      else if (sign === "-") kind = "del";
      else kind = "context";
      const text =
        sign === " " || sign === "+" || sign === "-" ? body.slice(1) : body;
      const row: HunkRow = {
        kind,
        text,
        oldLine: kind === "add" ? null : oldLine,
        newLine: kind === "del" ? null : newLine,
        noNewline: false,
      };
      if (kind !== "add") {
        oldLine++;
        oldRemaining--;
        hunk.oldCount++;
      }
      if (kind !== "del") {
        newLine++;
        newRemaining--;
        hunk.newCount++;
      }
      hunk.rows.push(row);
      i++;
    }
    while (i < lines.length && lines[i].startsWith("\\")) {
      const last = hunk.rows[hunk.rows.length - 1];
      if (last) last.noNewline = true;
      i++;
    }
    current.hunks.push(hunk);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Row lookup
// ---------------------------------------------------------------------------

export interface RowLocation {
  hunk: Hunk;
  hunkIndex: number;
  rowIndex: number;
  row: HunkRow;
}

/** The hunk row carrying `line` on `side`, if the patch shows that line. */
export function findRow(
  file: FilePatch,
  side: DiffSide,
  line: number
): RowLocation | null {
  for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex++) {
    const hunk = file.hunks[hunkIndex];
    for (let rowIndex = 0; rowIndex < hunk.rows.length; rowIndex++) {
      const row = hunk.rows[rowIndex];
      if ((side === "old" ? row.oldLine : row.newLine) === line) {
        return { hunk, hunkIndex, rowIndex, row };
      }
    }
  }
  return null;
}

/** The number a row has on `side`, or null when it has none there. */
export function rowLine(row: HunkRow, side: DiffSide): number | null {
  return side === "old" ? row.oldLine : row.newLine;
}

// ---------------------------------------------------------------------------
// Single-patch line shifting
// ---------------------------------------------------------------------------

/** Result of moving a line across one patch. */
export type Shift = { kind: "same"; line: number } | { kind: "changed" };

/** First line number a hunk occupies on a side (a gap starts after `start`). */
function spanStart(start: number, count: number): number {
  return count === 0 ? start + 1 : start;
}

/**
 * Move an old-side line to the new side of one file patch. `undefined` means
 * the patch does not touch the file, so the line is unchanged. A deleted file
 * changes every line.
 */
export function shiftOldToNew(
  file: FilePatch | undefined,
  line: number
): Shift {
  if (!file) return { kind: "same", line };
  if (file.newPath === null) return { kind: "changed" };
  let delta = 0;
  for (const hunk of file.hunks) {
    const oldFirst = spanStart(hunk.oldStart, hunk.oldCount);
    const oldEnd = oldFirst + hunk.oldCount;
    if (line < oldFirst) return { kind: "same", line: line + delta };
    if (line < oldEnd) {
      const row = hunk.rows.find((candidate) => candidate.oldLine === line);
      return row && row.newLine !== null
        ? { kind: "same", line: row.newLine }
        : { kind: "changed" };
    }
    delta = spanStart(hunk.newStart, hunk.newCount) + hunk.newCount - oldEnd;
  }
  return { kind: "same", line: line + delta };
}

/** Move a new-side line to the old side of one file patch. */
export function shiftNewToOld(
  file: FilePatch | undefined,
  line: number
): Shift {
  if (!file) return { kind: "same", line };
  if (file.oldPath === null) return { kind: "changed" };
  let delta = 0;
  for (const hunk of file.hunks) {
    const newFirst = spanStart(hunk.newStart, hunk.newCount);
    const newEnd = newFirst + hunk.newCount;
    if (line < newFirst) return { kind: "same", line: line + delta };
    if (line < newEnd) {
      const row = hunk.rows.find((candidate) => candidate.newLine === line);
      return row && row.oldLine !== null
        ? { kind: "same", line: row.oldLine }
        : { kind: "changed" };
    }
    delta = spanStart(hunk.oldStart, hunk.oldCount) + hunk.oldCount - newEnd;
  }
  return { kind: "same", line: line + delta };
}

// ---------------------------------------------------------------------------
// Chains of tool-call patches
// ---------------------------------------------------------------------------

/** One recorded tool-call patch; chains are ordered oldest first. */
export interface ToolPatch {
  id: string;
  files: readonly FilePatch[];
}

function fileByOldPath(
  files: readonly FilePatch[],
  path: string
): FilePatch | undefined {
  return files.find((file) => file.oldPath === path);
}

function fileByNewPath(
  files: readonly FilePatch[],
  path: string
): FilePatch | undefined {
  return files.find((file) => file.newPath === path);
}

export type Unmapped = "removed" | "added";

export type Shifted =
  | { ok: true; path: string; line: number }
  | { ok: false; reason: Unmapped };

/**
 * Carry an old-side coordinate forward through `chain[from..]`: the result is
 * the same line after the last patch, or `removed` when some patch deleted it.
 */
export function shiftForward(
  chain: readonly ToolPatch[],
  from: number,
  path: string,
  line: number
): Shifted {
  let currentPath = path;
  let currentLine = line;
  for (let index = from; index < chain.length; index++) {
    const file = fileByOldPath(chain[index].files, currentPath);
    const shifted = shiftOldToNew(file, currentLine);
    if (shifted.kind === "changed") return { ok: false, reason: "removed" };
    currentLine = shifted.line;
    if (file?.newPath) currentPath = file.newPath;
  }
  return { ok: true, path: currentPath, line: currentLine };
}

/**
 * Carry a new-side coordinate backward through `chain[0..before)`, newest
 * first: the result is the same line before the first patch, or `added` when
 * some earlier patch created it.
 */
export function shiftBackward(
  chain: readonly ToolPatch[],
  before: number,
  path: string,
  line: number
): Shifted {
  let currentPath = path;
  let currentLine = line;
  for (let index = before - 1; index >= 0; index--) {
    const file = fileByNewPath(chain[index].files, currentPath);
    const shifted = shiftNewToOld(file, currentLine);
    if (shifted.kind === "changed") return { ok: false, reason: "added" };
    currentLine = shifted.line;
    if (file?.oldPath) currentPath = file.oldPath;
  }
  return { ok: true, path: currentPath, line: currentLine };
}

/** A hunk row located inside a particular file patch. */
export interface RowTarget {
  file: FilePatch;
  /** Index into the chain; -1 for a row of the All Changes patch. */
  patchIndex: number;
  location: RowLocation;
}

/**
 * The tool call that added a final (working tree) line, newest first. Null
 * when no call in the chain added it.
 */
function findAdder(
  chain: readonly ToolPatch[],
  path: string,
  line: number
): { index: number; path: string; line: number } | null {
  let currentPath = path;
  let currentLine = line;
  for (let index = chain.length - 1; index >= 0; index--) {
    const file = fileByNewPath(chain[index].files, currentPath);
    const shifted = shiftNewToOld(file, currentLine);
    if (shifted.kind === "changed") {
      return { index, path: currentPath, line: currentLine };
    }
    currentLine = shifted.line;
    if (file?.oldPath) currentPath = file.oldPath;
  }
  return null;
}

/**
 * The tool call that removed a baseline line, oldest first. Null when no call
 * in the chain removed it.
 */
function findRemover(
  chain: readonly ToolPatch[],
  path: string,
  line: number
): { index: number; path: string; line: number } | null {
  let currentPath = path;
  let currentLine = line;
  for (let index = 0; index < chain.length; index++) {
    const file = fileByOldPath(chain[index].files, currentPath);
    const shifted = shiftOldToNew(file, currentLine);
    if (shifted.kind === "changed") {
      return { index, path: currentPath, line: currentLine };
    }
    currentLine = shifted.line;
    if (file?.newPath) currentPath = file.newPath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Landing rules
// ---------------------------------------------------------------------------

/**
 * Where a row of tool call `index` lands in the All Changes patch.
 *
 * - add / context rows carry their new-side number forward through the later
 *   calls and land on the same new-side line of All Changes;
 * - deleted rows carry their old-side number back to the baseline and land on
 *   the same deleted row of All Changes.
 *
 * Null when a later call removed the line, an earlier call added it, All
 * Changes does not show it, or its text differs (a moved baseline).
 */
export function projectToolRowToWorktree(
  chain: readonly ToolPatch[],
  index: number,
  file: FilePatch,
  row: HunkRow,
  worktree: readonly FilePatch[]
): RowTarget | null {
  if (row.kind === "del") {
    if (file.oldPath === null || row.oldLine === null) return null;
    const baseline = shiftBackward(chain, index, file.oldPath, row.oldLine);
    if (!baseline.ok) return null;
    const target = fileByOldPath(worktree, baseline.path);
    const location = target && findRow(target, "old", baseline.line);
    if (!target || !location) return null;
    if (location.row.kind !== "del" || location.row.text !== row.text) {
      return null;
    }
    return { file: target, patchIndex: -1, location };
  }
  if (file.newPath === null || row.newLine === null) return null;
  const final = shiftForward(chain, index + 1, file.newPath, row.newLine);
  if (!final.ok) return null;
  const target = fileByNewPath(worktree, final.path);
  const location = target && findRow(target, "new", final.line);
  if (!target || !location || location.row.text !== row.text) return null;
  return { file: target, patchIndex: -1, location };
}

/**
 * Where a row of the All Changes patch lands in the single tool call that
 * produced it: added rows go to the call that added the line, deleted rows to
 * the call that removed it. Context rows have no producing call.
 */
export function projectWorktreeRowToToolCall(
  chain: readonly ToolPatch[],
  file: FilePatch,
  row: HunkRow
): RowTarget | null {
  if (row.kind === "add") {
    if (file.newPath === null || row.newLine === null) return null;
    const adder = findAdder(chain, file.newPath, row.newLine);
    if (!adder) return null;
    const target = fileByNewPath(chain[adder.index].files, adder.path);
    const location = target && findRow(target, "new", adder.line);
    if (!target || !location) return null;
    if (location.row.kind !== "add" || location.row.text !== row.text) {
      return null;
    }
    return { file: target, patchIndex: adder.index, location };
  }
  if (row.kind === "del") {
    if (file.oldPath === null || row.oldLine === null) return null;
    const remover = findRemover(chain, file.oldPath, row.oldLine);
    if (!remover) return null;
    const target = fileByOldPath(chain[remover.index].files, remover.path);
    const location = target && findRow(target, "old", remover.line);
    if (!target || !location) return null;
    if (location.row.kind !== "del" || location.row.text !== row.text) {
      return null;
    }
    return { file: target, patchIndex: remover.index, location };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Selections and hunk capture
// ---------------------------------------------------------------------------

/** A comment's line span on one side of a file in one patch. */
export interface LineSpan {
  side: DiffSide;
  startLine: number;
  endLine: number;
}

/** A selection endpoint as Pierre reports it. */
export interface SelectionPoint {
  side: "additions" | "deletions";
  line: number;
}

/**
 * Resolve a gutter selection to a commentable span of one file patch. The two
 * endpoints are put in patch order (a reversed drag is the same selection).
 * The side follows the later row (deleted rows are old side, everything else
 * new side), and the span is clamped to that row's hunk: endpoints on the
 * other side or in an earlier hunk start the span at the first row of the
 * range that has a number on the chosen side. An endpoint outside the patch
 * is ignored; null only when neither endpoint is a row of the patch.
 */
export function resolveSelection(
  file: FilePatch,
  start: SelectionPoint,
  end: SelectionPoint
): LineSpan | null {
  const locate = (point: SelectionPoint) =>
    findRow(file, point.side === "deletions" ? "old" : "new", point.line);
  const found = [locate(start), locate(end)].filter(
    (location): location is RowLocation => location !== null
  );
  if (found.length === 0) return null;
  found.sort((a, b) => a.hunkIndex - b.hunkIndex || a.rowIndex - b.rowIndex);
  const first = found[0];
  const last = found[found.length - 1];

  const side: DiffSide = last.row.kind === "del" ? "old" : "new";
  const endLine = rowLine(last.row, side);
  if (endLine === null) return null;
  const from = first.hunkIndex === last.hunkIndex ? first.rowIndex : 0;
  let startLine = endLine;
  for (let index = from; index <= last.rowIndex; index++) {
    const line = rowLine(last.hunk.rows[index], side);
    if (line !== null) {
      startLine = line;
      break;
    }
  }
  return { side, startLine, endLine };
}

function rowText(row: HunkRow): string {
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
  return `${sign}${row.text}${row.noNewline ? "\n\\ No newline at end of file" : ""}`;
}

/**
 * The diff hunk text from its `@@` header through the last commented row.
 * Null when `endLine` is not a row of the patch.
 */
export function captureHunk(
  file: FilePatch,
  side: DiffSide,
  endLine: number
): string | null {
  const location = findRow(file, side, endLine);
  if (!location) return null;
  const rows = location.hunk.rows.slice(0, location.rowIndex + 1);
  return [location.hunk.header, ...rows.map(rowText)].join("\n");
}

/** Rows of `file` on `side` for each line of the span, when all are shown. */
export function spanRows(file: FilePatch, span: LineSpan): HunkRow[] | null {
  const rows: HunkRow[] = [];
  for (let line = span.startLine; line <= span.endLine; line++) {
    const location = findRow(file, span.side, line);
    if (!location) return null;
    rows.push(location.row);
  }
  return rows;
}
