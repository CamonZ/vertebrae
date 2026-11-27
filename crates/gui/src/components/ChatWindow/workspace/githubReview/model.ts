import type {
  ComparisonSnapshot,
  GithubReviewComment,
  GithubReviewThread,
  GithubThreadMappingRequest,
  GithubThreadPlacement,
  GithubThreadPosition,
} from "../../../../bindings";

export type DiffSideName = "additions" | "deletions";

/** How a thread's published anchor relates to the line it is drawn on. */
export type ThreadDrift =
  /** Same lines, same place. */
  | { kind: "current" }
  /**
   * Same lines, `delta` lines away: moved by local edits (new side) or by a
   * different base (old side).
   */
  | { kind: "moved"; delta: number }
  /**
   * The commented lines differ in the shown comparison (local edits, or a
   * different base); drawn at the published line.
   */
  | { kind: "edited" }
  /** The published commit is not in this clone; drawn where GitHub says. */
  | { kind: "unverified" };

/** A thread with where it is in the shown comparison. */
export type PlacedThread =
  | {
      kind: "line";
      thread: GithubReviewThread;
      side: DiffSideName;
      /** First commented line in the shown comparison (`line` for one line). */
      startLine: number;
      line: number;
      publishedLine: number;
      drift: ThreadDrift;
      /** The published commented lines, for an edited anchor. */
      published: GithubSnippetLines;
      /**
       * The diff shows this line, so the thread has a marker there; else it
       * is read from the Review rail.
       */
      inDiff: boolean;
    }
  | {
      kind: "outdated";
      thread: GithubReviewThread;
      originalStartLine: number | null;
      originalLine: number | null;
      original: GithubSnippetLines;
    }
  /** File-level comments, or files the comparison does not show. */
  | { kind: "file"; thread: GithubReviewThread; shown: boolean }
  /** GitHub's anchor cannot be placed on the local file. */
  | {
      kind: "unplaceable";
      thread: GithubReviewThread;
      reason: Extract<GithubThreadPlacement, { kind: "unplaceable" }>["reason"];
    };

type GithubSnippetLines = Extract<
  GithubThreadPlacement,
  { kind: "edited" }
>["published"];

/** Every thread on one line of one side: drawn as one stacked marker. */
export interface ThreadMarker {
  key: string;
  path: string;
  side: DiffSideName;
  line: number;
  threads: readonly Extract<PlacedThread, { kind: "line" }>[];
}

export interface ReviewFile {
  path: string;
  threads: readonly PlacedThread[];
}

export interface GithubReviewModel {
  prNumber: number;
  markersByPath: ReadonlyMap<string, readonly ThreadMarker[]>;
  markerByKey: ReadonlyMap<string, ThreadMarker>;
  outdatedByPath: ReadonlyMap<string, readonly PlacedThread[]>;
  /** Files in path order, threads in line order: the Review rail's index. */
  files: readonly ReviewFile[];
  byThread: ReadonlyMap<string, PlacedThread>;
  openCount: number;
  truncated: boolean;
}

export function markerKey(path: string, side: DiffSideName, line: number) {
  return JSON.stringify([path, side, line]);
}

export function sideName(
  side: GithubReviewThread["anchor"]["side"]
): DiffSideName {
  return side === "LEFT" ? "deletions" : "additions";
}

/** The comparison Changes shows, as the placement command reads it. */
export function mappingRequest(
  headOid: string,
  baseOid: string,
  comparison: ComparisonSnapshot,
  threads: readonly GithubReviewThread[]
): GithubThreadMappingRequest {
  return {
    headOid,
    baseOid,
    shownTarget: comparison.working_tree ? null : comparison.target_commit,
    shownBase: comparison.base_commit,
    threads: threads.map((thread) => ({
      threadId: thread.id,
      anchor: thread.anchor,
    })),
  };
}

function placeThread(
  thread: GithubReviewThread,
  placement: GithubThreadPlacement
): PlacedThread {
  const side = sideName(thread.anchor.side);
  switch (placement.kind) {
    case "anchored": {
      const delta = placement.line - placement.publishedLine;
      return {
        kind: "line",
        thread,
        side,
        startLine: placement.startLine,
        line: placement.line,
        publishedLine: placement.publishedLine,
        drift: delta === 0 ? { kind: "current" } : { kind: "moved", delta },
        published: [],
        inDiff: false,
      };
    }
    case "edited":
      return {
        kind: "line",
        thread,
        side,
        startLine: placement.startLine,
        line: placement.line,
        publishedLine: placement.line,
        drift: { kind: "edited" },
        published: placement.published,
        inDiff: false,
      };
    case "unverified":
      return {
        kind: "line",
        thread,
        side,
        startLine: placement.startLine,
        line: placement.line,
        publishedLine: placement.line,
        drift: { kind: "unverified" },
        published: [],
        inDiff: false,
      };
    case "outdated":
      return {
        kind: "outdated",
        thread,
        originalStartLine: placement.originalStartLine,
        originalLine: placement.originalLine,
        original: placement.original,
      };
    case "file_level":
      return { kind: "file", thread, shown: true };
    case "not_shown":
      return { kind: "file", thread, shown: false };
    case "unplaceable":
      return { kind: "unplaceable", thread, reason: placement.reason };
  }
}

function lineOf(placed: PlacedThread): number {
  if (placed.kind === "line") return placed.line;
  if (placed.kind === "outdated") return placed.originalLine ?? 0;
  return 0;
}

/** Whether the shown diff has a row for a line of a file. */
export type LineShown = (
  path: string,
  side: DiffSideName,
  line: number
) => boolean;

interface HunkSpan {
  additionStart: number;
  additionCount: number;
  deletionStart: number;
  deletionCount: number;
}

/** Rows of a file's hunks (collapsed context between hunks has none). */
export function hunksShow(
  hunks: readonly HunkSpan[],
  side: DiffSideName,
  line: number
): boolean {
  return hunks.some((hunk) => {
    const start =
      side === "additions" ? hunk.additionStart : hunk.deletionStart;
    const count =
      side === "additions" ? hunk.additionCount : hunk.deletionCount;
    return line >= start && line < start + count;
  });
}

/**
 * Group placed threads for the diff (markers per shown line, outdated per
 * file) and for the Review rail (by file). Threads not yet placed (placement
 * still loading) are left out rather than drawn at an unverified line.
 */
export function buildReviewModel(
  prNumber: number,
  threads: readonly GithubReviewThread[],
  positions: readonly GithubThreadPosition[],
  truncated: boolean,
  shown: LineShown = () => true
): GithubReviewModel {
  const placements = new Map(
    positions.map((position) => [position.threadId, position.placement])
  );
  const byThread = new Map<string, PlacedThread>();
  const markerByKey = new Map<string, ThreadMarker>();
  const outdatedByPath = new Map<string, PlacedThread[]>();
  const byFile = new Map<string, PlacedThread[]>();
  for (const thread of threads) {
    const placement = placements.get(thread.id);
    if (!placement) continue;
    const base = placeThread(thread, placement);
    const { path } = thread.anchor;
    const placed =
      base.kind === "line"
        ? { ...base, inDiff: shown(path, base.side, base.line) }
        : base;
    byThread.set(thread.id, placed);
    byFile.set(path, [...(byFile.get(path) ?? []), placed]);
    if (placed.kind === "outdated") {
      outdatedByPath.set(path, [...(outdatedByPath.get(path) ?? []), placed]);
    } else if (placed.kind === "line" && placed.inDiff) {
      const key = markerKey(path, placed.side, placed.line);
      const marker = markerByKey.get(key);
      markerByKey.set(key, {
        key,
        path,
        side: placed.side,
        line: placed.line,
        threads: [...(marker?.threads ?? []), placed],
      });
    }
  }
  const markersByPath = new Map<string, ThreadMarker[]>();
  for (const marker of markerByKey.values())
    markersByPath.set(marker.path, [
      ...(markersByPath.get(marker.path) ?? []),
      marker,
    ]);
  const files = [...byFile]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, placed]) => ({
      path,
      threads: [...placed].sort((a, b) => lineOf(a) - lineOf(b)),
    }));
  return {
    prNumber,
    markersByPath,
    markerByKey,
    outdatedByPath,
    files,
    byThread,
    openCount: threads.filter((thread) => !thread.resolved).length,
    truncated,
  };
}

function span(start: number | null, line: number): string {
  return start !== null && start < line
    ? `lines ${start}–${line}`
    : `line ${line}`;
}

/** "line 47", "lines 45–47", or "outdated · was line 39". */
export function lineLabel(placed: PlacedThread): string {
  switch (placed.kind) {
    case "outdated":
      return placed.originalLine
        ? `outdated · was ${span(placed.originalStartLine, placed.originalLine)}`
        : "outdated";
    case "file":
      return placed.shown ? "file" : "not in this comparison";
    case "unplaceable":
      return "not placeable here";
    case "line":
      return span(placed.startLine, placed.line);
  }
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Why a drawn thread is not plainly at its published line. */
export function driftExplanation(
  placed: Extract<PlacedThread, { kind: "line" }>
): string | null {
  const { drift, publishedLine } = placed;
  // The old side is the comparison's base, which local edits never touch.
  const base = placed.side === "deletions";
  switch (drift.kind) {
    case "current":
      return null;
    case "moved": {
      const by = `${plural(Math.abs(drift.delta), "line")} ${drift.delta > 0 ? "down" : "up"}`;
      return base
        ? `Published on line ${publishedLine} of the PR's base; this comparison's base has it ${by}.`
        : `Published on line ${publishedLine}; your local edits moved it ${by}. GitHub re-anchors after you push.`;
    }
    case "edited":
      return base
        ? `The commented line differs in this comparison's base; reviewers still see line ${publishedLine} of the PR's base.`
        : `You edited the commented line locally; reviewers still see line ${publishedLine} as published.`;
    case "unverified":
      return `Shown on line ${publishedLine} as published; fetch the PR branch to check it against your local copy.`;
  }
}

export function authorsOf(threads: readonly PlacedThread[]): string[] {
  const names: string[] = [];
  for (const { thread } of threads) {
    const login = thread.comments[0]?.author?.login ?? "ghost";
    if (!names.includes(login)) names.push(login);
  }
  return names;
}

/** The marker's accessible name: who, where, drift and resolution. */
export function markerLabel(marker: ThreadMarker): string {
  const names = authorsOf(marker.threads).join(", ");
  const count = marker.threads.length;
  const resolved = marker.threads.filter(
    ({ thread }) => thread.resolved
  ).length;
  const drifts = new Set(marker.threads.map(({ drift }) => drift.kind));
  // The old side is the comparison's base, which local edits never touch.
  const base = marker.side === "deletions";
  const drift = drifts.has("edited")
    ? base
      ? ", commented line differs in this comparison's base"
      : ", commented line edited locally"
    : drifts.has("moved")
      ? base
        ? ", anchor moved in this comparison's base"
        : ", anchor moved by local edits"
      : drifts.has("unverified")
        ? ", not checked against local edits"
        : "";
  const state =
    resolved === 0
      ? ""
      : resolved === count
        ? ", resolved"
        : `, ${count - resolved} open, ${resolved} resolved`;
  return `${plural(count, "GitHub thread")} from ${names} on line ${marker.line}${drift}${state}`;
}

/** Stable hue per login, so a reviewer keeps their colour everywhere. */
export function avatarHue(login: string): number {
  let hash = 0;
  for (const char of login) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

export function initialOf(login: string): string {
  return (
    login.codePointAt(0) ? String.fromCodePoint(login.codePointAt(0)!) : "?"
  ).toUpperCase();
}

export function authorOf(comment: GithubReviewComment | undefined): string {
  return comment?.author?.login ?? "ghost";
}

/** The first non-blank line of a comment, for one-line summaries. */
export function firstLine(text: string) {
  return text.split("\n").find((line) => line.trim()) ?? "";
}
