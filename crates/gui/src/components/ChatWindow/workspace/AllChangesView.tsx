import { useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import {
  CodeView,
  WorkerPoolContext,
  type CodeViewAnnotationArgs,
  type CodeViewDiffItem,
  type CodeViewHandle,
} from "@pierre/diffs/react";
import type { WorktreeChange } from "../../../bindings";
import { usePierreDiffOptions } from "../../../hooks/useCodeAppearance";
import { useDiffComments } from "../../../hooks/useDiffComments";
import type { ReviewAnnotation } from "../../thread/toolChange/DiffCommentThread";
import { DiffReviewContext } from "../../thread/toolChange/DiffReviewContext";
import { parseWorktreeSnapshot } from "../../thread/toolChange/diffComments";
import { MARKER_TEXT } from "../../thread/toolChange/worktreeDelta";
import { diffWorkerPool } from "../../thread/toolChange/diffWorkerPool";

export interface JumpTarget {
  path: string;
  /** Distinguishes repeated jumps to the same file. */
  nonce: number;
}

export interface AllChangesViewProps {
  files: readonly WorktreeChange[];
  /** Scroll the shared viewport to this changed file. */
  jumpTarget: JumpTarget | null;
  onOpen(path: string): void;
}

const FALLBACK_ATTRIBUTE = "data-changes-fallback";

/**
 * Every changed file in one virtualized Pierre viewport. Files without text
 * hunks (binary, oversized, unreadable, metadata-only) are listed above the
 * diffs so they stay inspectable. Loaded lazily so Pierre stays out of the
 * main chunk.
 */
export default function AllChangesView({
  files,
  jumpTarget,
  onOpen,
}: AllChangesViewProps): ReactNode {
  const options = usePierreDiffOptions();
  const viewRef = useRef<CodeViewHandle<ReviewAnnotation, undefined>>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { items, fallbacks, itemPaths } = useMemo(() => {
    const items: CodeViewDiffItem<ReviewAnnotation>[] = [];
    const fallbacks: { file: WorktreeChange; text: string }[] = [];
    const itemPaths = new Map<string, string>();
    for (const file of files) {
      if (file.marker) {
        fallbacks.push({ file, text: MARKER_TEXT[file.marker] });
        continue;
      }
      let diffs;
      try {
        diffs = parsePatchFiles(file.patch).flatMap((patch) => patch.files);
      } catch {
        fallbacks.push({ file, text: "Diff could not be displayed" });
        continue;
      }
      if (diffs.length === 0) {
        fallbacks.push({
          file,
          text: "No text hunks (mode or metadata change).",
        });
        continue;
      }
      diffs.forEach((fileDiff, index) => {
        const id = index === 0 ? file.path : `${file.path}#${index}`;
        itemPaths.set(id, file.path);
        items.push({ id, type: "diff", fileDiff });
      });
    }
    return { items, fallbacks, itemPaths };
  }, [files]);

  // Review comments: parsed patch files for resolving gutter selections, and
  // Pierre annotations per file from the shared pending comments.
  const patchFiles = useMemo(
    () =>
      parseWorktreeSnapshot(
        false,
        files.filter((file) => !file.marker).map((file) => file.patch)
      ).files,
    [files]
  );
  const review = useDiffComments({ kind: "worktree" }, patchFiles);
  const { annotationsFor, openComposer, onSelectionChange, selectedLinesFor } =
    review;
  const itemVersions = useRef(
    new Map<string, { fileDiff: unknown; signature: string; version: number }>()
  );
  // CodeView keeps an item until its `version` changes, so annotation or
  // diff changes publish a new version.
  const reviewItems = useMemo(
    () =>
      items.map((item): CodeViewDiffItem<ReviewAnnotation> => {
        const annotations =
          item.id === itemPaths.get(item.id)
            ? annotationsFor(item.id)
            : undefined;
        const signature = JSON.stringify(annotations ?? []);
        const previous = itemVersions.current.get(item.id);
        const changed =
          previous !== undefined &&
          (previous.fileDiff !== item.fileDiff ||
            previous.signature !== signature);
        const version = (previous?.version ?? 0) + (changed ? 1 : 0);
        itemVersions.current.set(item.id, {
          fileDiff: item.fileDiff,
          signature,
          version,
        });
        return { ...item, annotations, version };
      }),
    [items, itemPaths, annotationsFor]
  );
  // Controlled selection (null when none) so a composer can clear it.
  const selectedPath = reviewItems.find((item) =>
    selectedLinesFor(item.id)
  )?.id;
  const selectedLines = review.enabled
    ? selectedPath
      ? { id: selectedPath, range: selectedLinesFor(selectedPath)! }
      : null
    : undefined;
  const codeViewOptions = useMemo(
    () => ({
      ...options,
      stickyHeaders: true,
      ...(review.enabled
        ? {
            enableGutterUtility: true,
            // Click, drag or shift-click line numbers to select a range,
            // then press the gutter "+" to comment on all of it.
            enableLineSelection: true,
            onGutterUtilityClick: (
              range: Parameters<typeof openComposer>[1],
              context: { item: { id: string } }
            ) =>
              openComposer(
                itemPaths.get(context.item.id) ?? context.item.id,
                range
              ),
          }
        : {}),
    }),
    [options, review.enabled, openComposer, itemPaths]
  );

  // Bring a requested comment into view once per request.
  const diffReview = useContext(DiffReviewContext);
  const focus = diffReview?.focus ?? null;
  const placements = diffReview?.placements;
  const handledFocus = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || !placements || handledFocus.current === focus.nonce) return;
    const matches = placements.filter(
      (placement) =>
        placement.commentId === focus.commentId &&
        placement.surface.kind === "worktree"
    );
    const target = matches.find((placement) => placement.home) ?? matches[0];
    if (!target || !itemPaths.has(target.path)) return;
    handledFocus.current = focus.nonce;
    viewRef.current?.scrollTo(
      target.endLine > 0
        ? {
            type: "line",
            id: target.path,
            lineNumber: target.endLine,
            side: target.side === "old" ? "deletions" : "additions",
            align: "center",
          }
        : { type: "item", id: target.path, align: "start" }
    );
  }, [focus, placements, itemPaths]);

  // Jump once per request; background refreshes must not move the viewport.
  const handledJump = useRef<number | null>(null);
  useEffect(() => {
    if (!jumpTarget || handledJump.current === jumpTarget.nonce) return;
    handledJump.current = jumpTarget.nonce;
    const { path } = jumpTarget;
    if (itemPaths.has(path)) {
      viewRef.current?.scrollTo({ type: "item", id: path, align: "start" });
      return;
    }
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>(
      `[${FALLBACK_ATTRIBUTE}="${CSS.escape(path)}"]`
    );
    if (container && target) {
      const top =
        target.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
      container.scrollTo({ top, behavior: "auto" });
    }
  }, [jumpTarget, itemPaths]);

  return (
    <WorkerPoolContext.Provider value={diffWorkerPool}>
      <CodeView
        ref={viewRef}
        containerRef={containerRef}
        className="changes-code-view"
        items={reviewItems}
        options={codeViewOptions}
        selectedLines={selectedLines}
        onSelectedLinesChange={
          review.enabled
            ? (next) =>
                onSelectionChange(
                  next ? (itemPaths.get(next.id) ?? next.id) : "",
                  next ? next.range : null
                )
            : undefined
        }
        renderAnnotation={
          review.enabled
            ? (...args: CodeViewAnnotationArgs<ReviewAnnotation>) =>
                review.renderAnnotation(args[0])
            : undefined
        }
        renderHeaderMetadata={(item) => {
          const path = itemPaths.get(item.id) ?? item.id;
          return (
            <button
              type="button"
              className="changes-open-button"
              aria-label={`Open ${path}`}
              onClick={() => onOpen(path)}
            >
              Open
            </button>
          );
        }}
        renderCodeViewHeader={
          fallbacks.length > 0
            ? () => (
                <div className="changes-fallbacks">
                  {fallbacks.map(({ file, text }) => (
                    <p
                      key={file.path}
                      className="changes-file-fallback"
                      {...{ [FALLBACK_ATTRIBUTE]: file.path }}
                    >
                      <span className="font-mono">{file.path}</span>
                      <span>{text}</span>
                    </p>
                  ))}
                </div>
              )
            : undefined
        }
      />
    </WorkerPoolContext.Provider>
  );
}
