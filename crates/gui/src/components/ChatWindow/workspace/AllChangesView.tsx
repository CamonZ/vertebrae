import type { DiffPreferences } from "../../../utils/codeAppearance";
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
import type { BackgroundOutputs } from "../../../background/types";
import { MARKER_TEXT } from "../../thread/toolChange/worktreeDelta";
import { diffWorkerPool } from "../../thread/toolChange/diffWorkerPool";

export interface JumpTarget {
  path: string;
  /** Distinguishes repeated jumps to the same file. */
  nonce: number;
}

export interface AllChangesViewProps {
  files: readonly WorktreeChange[];
  parsedPatches: BackgroundOutputs["patch"];
  /** Scroll the shared viewport to this changed file. */
  jumpTarget: JumpTarget | null;
  onOpen(path: string): void;
  diffStyle?: DiffPreferences["diffStyle"];
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
  parsedPatches,
  jumpTarget,
  onOpen,
  diffStyle,
}: AllChangesViewProps): ReactNode {
  const options = usePierreDiffOptions();
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(
    new Set()
  );
  const viewRef = useRef<CodeViewHandle<ReviewAnnotation, undefined>>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { items, fallbacks, itemPaths } = useMemo(() => {
    const items: CodeViewDiffItem<ReviewAnnotation>[] = [];
    const fallbacks: { file: WorktreeChange; text: string }[] = [];
    const itemPaths = new Map<string, string>();

    for (const [fileIndex, file] of files.entries()) {
      if (file.marker) {
        fallbacks.push({ file, text: MARKER_TEXT[file.marker] });
        continue;
      }

      const diffs = parsedPatches[fileIndex]?.files;
      if (!diffs) {
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
  }, [files, parsedPatches]);

  // Retained paths keep their folding through patch/annotation refreshes. Removed
  // files must start expanded if they appear again later.
  useEffect(() => {
    const paths = new Set(files.map((file) => file.path));
    setCollapsedPaths((current) => {
      const retained = new Set([...current].filter((path) => paths.has(path)));
      return retained.size === current.size ? current : retained;
    });
    for (const id of itemVersions.current.keys()) {
      if (!itemPaths.has(id)) itemVersions.current.delete(id);
    }
  }, [files, itemPaths]);

  // Review comments: parsed patch files for resolving gutter selections, and
  // Pierre annotations per file from the shared pending comments.
  const patchFiles = useMemo(
    () =>
      parsedPatches.flatMap((result, index) =>
        collapsedPaths.has(files[index]?.path) ? [] : result.reviewFiles
      ),
    [parsedPatches, files, collapsedPaths]
  );
  const review = useDiffComments({ kind: "worktree" }, patchFiles);
  const { annotationsFor, openComposer, onSelectionChange, selectedLinesFor } =
    review;
  const itemVersions = useRef(
    new Map<
      string,
      {
        fileDiff: unknown;
        signature: string;
        collapsed: boolean;
        version: number;
      }
    >()
  );
  // CodeView keeps an item until its `version` changes. Publish annotation,
  // diff and folding changes through that same reconciliation contract.
  const reviewItems = useMemo(
    () =>
      items.map((item): CodeViewDiffItem<ReviewAnnotation> => {
        const annotations =
          item.id === itemPaths.get(item.id)
            ? annotationsFor(item.id)
            : undefined;
        const signature = JSON.stringify(annotations ?? []);
        const collapsed = collapsedPaths.has(itemPaths.get(item.id) ?? item.id);
        const previous = itemVersions.current.get(item.id);
        const changed =
          previous !== undefined &&
          (previous.fileDiff !== item.fileDiff ||
            previous.signature !== signature ||
            previous.collapsed !== collapsed);
        const version = (previous?.version ?? 0) + (changed ? 1 : 0);
        itemVersions.current.set(item.id, {
          fileDiff: item.fileDiff,
          signature,
          collapsed,
          version,
        });
        return { ...item, annotations, collapsed, version };
      }),
    [items, itemPaths, annotationsFor, collapsedPaths]
  );
  // Controlled selection (null when none) so a composer can clear it.
  const selectedPath = reviewItems.find(
    (item) => !item.collapsed && selectedLinesFor(item.id)
  )?.id;
  const selectedLines = review.enabled
    ? selectedPath
      ? { id: selectedPath, range: selectedLinesFor(selectedPath)! }
      : null
    : undefined;
  const codeViewOptions = useMemo(
    () => ({
      ...options,
      ...(diffStyle ? { diffStyle } : {}),
      stickyHeaders: true,
      ...(review.enabled
        ? {
            enableGutterUtility: true,
            // Click, drag or shift-click line numbers to select a range,
            // then choose an explicit action for that selection.
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
    [options, diffStyle, review.enabled, openComposer, itemPaths]
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
    if (collapsedPaths.has(target.path)) {
      setCollapsedPaths(
        (current) =>
          new Set([...current].filter((path) => path !== target.path))
      );
      return; // Scroll after CodeView has received the expanded item version.
    }
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
  }, [focus, placements, itemPaths, collapsedPaths]);

  // Jump once per request; background refreshes must not move the viewport.
  const handledJump = useRef<number | null>(null);
  useEffect(() => {
    if (!jumpTarget || handledJump.current === jumpTarget.nonce) return;
    const { path } = jumpTarget;
    if (collapsedPaths.has(path)) {
      setCollapsedPaths(
        (current) => new Set([...current].filter((value) => value !== path))
      );
      return;
    }
    handledJump.current = jumpTarget.nonce;
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
  }, [jumpTarget, itemPaths, collapsedPaths]);

  return (
    <WorkerPoolContext.Provider value={diffWorkerPool}>
      <div {...review.keyboardProps} className="flex min-h-0 flex-1 flex-col">
        <CodeView
          ref={viewRef}
          containerRef={containerRef}
          className="changes-code-view"
          items={reviewItems}
          options={codeViewOptions}
          selectedLines={selectedLines}
          onSelectedLinesChange={
            review.enabled
              ? (next) => {
                  const path = next ? (itemPaths.get(next.id) ?? next.id) : "";
                  const range = next ? next.range : null;

                  onSelectionChange(path, range);
                }
              : undefined
          }
          renderAnnotation={
            review.enabled
              ? (...args: CodeViewAnnotationArgs<ReviewAnnotation>) =>
                  review.renderAnnotation(args[0])
              : undefined
          }
          renderCustomHeader={(item) => {
            const path = itemPaths.get(item.id) ?? item.id;
            const collapsed = collapsedPaths.has(path);
            const fileDiff = item.type === "diff" ? item.fileDiff : undefined;
            return (
              <div className="changes-diff-heading">
                <button
                  type="button"
                  className="changes-fold-button"
                  aria-label={`Toggle diff for ${path}`}
                  aria-expanded={!collapsed}
                  onClick={() => {
                    if (!collapsed) review.clearInteraction(path);
                    setCollapsedPaths((current) => {
                      const next = new Set(current);
                      if (collapsed) next.delete(path);
                      else next.add(path);
                      return next;
                    });
                  }}
                >
                  <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
                  <span className="changes-diff-name">
                    {fileDiff?.prevName && <>{fileDiff.prevName} → </>}
                    {fileDiff?.name ?? path}
                  </span>
                </button>
                {fileDiff && (
                  <span className="changes-diff-totals">
                    <span className="changes-diff-deletions">
                      −
                      {fileDiff.hunks.reduce(
                        (sum, hunk) => sum + hunk.deletionLines,
                        0
                      )}
                    </span>
                    <span className="changes-diff-additions">
                      +
                      {fileDiff.hunks.reduce(
                        (sum, hunk) => sum + hunk.additionLines,
                        0
                      )}
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  className="changes-open-button"
                  aria-label={`Open ${path}`}
                  onClick={() => onOpen(path)}
                >
                  Open
                </button>
              </div>
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
      </div>
    </WorkerPoolContext.Provider>
  );
}
