import { useEffect, useMemo } from "react";
import type { ReviewAnnotation } from "../../../thread/toolChange/DiffCommentThread";
import {
  fileRows,
  type FileContext,
} from "../../../thread/toolChange/diffGaps";
import type { FilePatch } from "../../../thread/toolChange/diffLineMapper";
import { syncGithubMarkers } from "./markers";
import { markerKey, type DiffSideName, type LineShown } from "./model";
import type { GithubDiffThreads } from "./useReviewController";

interface LineAnnotation {
  side: DiffSideName;
  lineNumber: number;
  metadata: ReviewAnnotation;
}

/**
 * Adds the expanded GitHub threads to a file's annotations: a marker's open
 * threads join its line's slot (one slot per line), and the file's open
 * outdated threads join the slot of its first diff row. Both can share a
 * slot; `GithubAnnotationThreads` draws each.
 */
export function withGithubAnnotations(
  github: GithubDiffThreads | null,
  path: string,
  annotations: readonly LineAnnotation[],
  firstRow: { side: DiffSideName; lineNumber: number } | null
): LineAnnotation[] {
  if (!github) return [...annotations];
  const isOpen = (threadId: string) => github.openThreads.has(threadId);
  const extra: {
    side: DiffSideName;
    lineNumber: number;
    metadata: Partial<ReviewAnnotation>;
  }[] = [];
  for (const marker of github.model.markersByPath.get(path) ?? [])
    if (marker.threads.some(({ thread }) => isOpen(thread.id)))
      extra.push({
        side: marker.side,
        lineNumber: marker.line,
        metadata: { githubMarker: marker.key },
      });
  const outdated = github.model.outdatedByPath.get(path) ?? [];
  if (firstRow && outdated.some(({ thread }) => isOpen(thread.id)))
    extra.push({ ...firstRow, metadata: { githubOutdated: true } });
  if (extra.length === 0) return [...annotations];
  const merged = new Map(
    annotations.map((annotation) => [
      `${annotation.side}:${annotation.lineNumber}`,
      annotation,
    ])
  );
  for (const { side, lineNumber, metadata } of extra) {
    const key = `${side}:${lineNumber}`;
    const existing = merged.get(key);
    merged.set(key, {
      side,
      lineNumber,
      metadata: {
        ...(existing?.metadata ?? { commentIds: [], draft: false }),
        ...metadata,
      },
    });
  }
  return [...merged.values()];
}

/**
 * The line cursor's GitHub stops: ⌥↑/↓ stops at marker lines, and `o` on
 * one toggles its threads.
 */
export function githubCursorStops(github: GithubDiffThreads | null) {
  if (!github) return {};
  return {
    marks: (path: string) =>
      (github.model.markersByPath.get(path) ?? []).map((marker) => ({
        side: marker.side,
        line: marker.line,
      })),
    onOpenAt: (path: string, side: DiffSideName, line: number) => {
      const marker = github.model.markerByKey.get(markerKey(path, side, line));
      if (!marker) return false;
      github.toggleMarker(marker);
      return true;
    },
  };
}

interface MarkerDiff {
  getLineIndex(line: number, side: DiffSideName): readonly number[] | undefined;
}

/**
 * Draws a file's GitHub markers into its rendered Pierre item, and gives
 * focus back to a marker waiting for it. `rendered`: Pierre has just drawn
 * the item, so its rows are final and a focused marker stays focused.
 */
export function paintGithubMarkers(
  root: ShadowRoot,
  host: HTMLElement,
  diff: MarkerDiff,
  github: GithubDiffThreads | null,
  path: string,
  primary: boolean,
  rendered: boolean
) {
  // Markers go on the file's primary patch item, like semantic labels.
  const markers =
    github && primary ? (github.model.markersByPath.get(path) ?? []) : [];
  const focusKey =
    github?.focusMarker &&
    github.model.markerByKey.get(github.focusMarker)?.path === path
      ? github.focusMarker
      : undefined;
  const focused = syncGithubMarkers(
    root,
    host,
    diff,
    markers,
    (key) =>
      !!github?.model.markerByKey
        .get(key)
        ?.threads.some(({ thread }) => github.openThreads.has(thread.id)),
    (marker) => github?.toggleMarker(marker),
    focusKey
  );
  if (focused && rendered) github?.markerFocused();
}

/**
 * Reports which lines the diff shows, revealed context included, so a
 * thread on a line revealed by hand gets its marker there instead of being
 * read from the Review rail.
 */
export function useReportShownLines(
  patches: ReadonlyMap<string, FilePatch>,
  context: (path: string) => FileContext | undefined,
  onLinesShown: ((shown: LineShown) => void) | undefined
) {
  const shown = useMemo<LineShown>(() => {
    const byPath = new Map<string, { old: Set<number>; new: Set<number> }>();
    return (path, side, line) => {
      let lines = byPath.get(path);
      if (!lines) {
        lines = { old: new Set(), new: new Set() };
        const patch = patches.get(path);
        for (const row of patch ? fileRows(patch, context(path)) : [])
          if (row.kind === "line") {
            if (row.row.oldLine !== null) lines.old.add(row.row.oldLine);
            if (row.row.newLine !== null) lines.new.add(row.row.newLine);
          }
        byPath.set(path, lines);
      }
      return (side === "deletions" ? lines.old : lines.new).has(line);
    };
  }, [patches, context]);
  useEffect(() => onLinesShown?.(shown), [shown, onLinesShown]);
}
