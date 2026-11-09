import { useContext, useEffect, useMemo, useRef } from "react";
import {
  CodeView,
  type CodeViewAnnotationArgs,
  type CodeViewDiffItem,
  type CodeViewHandle,
} from "@pierre/diffs/react";
import type { CodeViewLineSelection, FileDiffMetadata } from "@pierre/diffs";
import { usePierreDiffOptions } from "../../../hooks/useCodeAppearance";
import type { DiffCommentsApi } from "../../../hooks/useDiffComments";
import { DiffReviewContext } from "./DiffReviewContext";
import type { ReviewAnnotation } from "./DiffCommentThread";

/** One row- and file-virtualized scroll root for the entire inline frame. */
export function InlinePatchView({
  files,
  comments,
  reviewing,
  toolUseId,
  maxHeight,
}: {
  files: FileDiffMetadata[];
  comments: DiffCommentsApi;
  reviewing: boolean;
  toolUseId?: string;
  maxHeight: number;
}) {
  const appearance = usePierreDiffOptions();
  const viewRef = useRef<CodeViewHandle<ReviewAnnotation, undefined>>(null);
  const { annotationsFor, selectedLinesFor, openComposer, onSelectionChange } =
    comments;

  const versions = useRef(
    new Map<
      string,
      { file: FileDiffMetadata; signature: string; version: number }
    >()
  );

  const items = useMemo(() => {
    const nextVersions = new Map<
      string,
      { file: FileDiffMetadata; signature: string; version: number }
    >();

    const next = files.map(
      (file, index): CodeViewDiffItem<ReviewAnnotation> => {
        const id = `${index}:${file.prevName ?? ""}>${file.name}`;
        const annotations = reviewing ? annotationsFor(file.name) : undefined;
        const signature = JSON.stringify(annotations ?? []);

        const previous = versions.current.get(id);
        const changed =
          previous &&
          (previous.file !== file || previous.signature !== signature);
        const version = (previous?.version ?? 0) + (changed ? 1 : 0);

        nextVersions.set(id, { file, signature, version });

        return { id, type: "diff", fileDiff: file, annotations, version };
      }
    );

    versions.current = nextVersions;

    return next;
  }, [files, reviewing, annotationsFor]);

  const paths = useMemo(() => {
    const entries = items.map((item) => [item.id, item.fileDiff.name] as const);

    return new Map(entries);
  }, [items]);
  const selected = reviewing
    ? items.find((item) => selectedLinesFor(item.fileDiff.name))
    : undefined;

  const revealKeyboardSelection = useRef(false);

  useEffect(() => {
    if (!revealKeyboardSelection.current) return;

    revealKeyboardSelection.current = false;
    const range = selected && selectedLinesFor(selected.fileDiff.name);

    if (!selected || !range) return;

    viewRef.current?.scrollTo({
      type: "line",
      id: selected.id,
      lineNumber: range.end,
      side: range.endSide ?? range.side ?? "additions",
      align: "nearest",
    });
  });

  const options = useMemo(
    () => ({
      ...appearance,
      ...(reviewing
        ? {
            enableGutterUtility: true,
            enableLineSelection: true,
            onGutterUtilityClick: (
              range: Parameters<typeof openComposer>[1],
              context: { item: { id: string } }
            ) => {
              const path = paths.get(context.item.id);

              if (path) openComposer(path, range);
            },
          }
        : {}),
    }),
    [appearance, reviewing, openComposer, paths]
  );

  // Offscreen annotations have no DOM to scrollIntoView. Reveal their logical
  // line first; the mounted comment then brings its card into view.
  const review = useContext(DiffReviewContext);
  const focus = review?.focus;
  const placements = review?.placements;
  const handledFocus = useRef<number | null>(null);

  useEffect(() => {
    if (!reviewing || !focus || handledFocus.current === focus.nonce) return;

    const matches = placements?.filter(
      (placement) =>
        placement.commentId === focus.commentId &&
        placement.surface.kind === "tool_call" &&
        placement.surface.toolUseId === toolUseId
    );

    const target = matches?.find((placement) => placement.home) ?? matches?.[0];
    const item =
      target && items.find((item) => item.fileDiff.name === target.path);

    if (!target || !item) return;

    handledFocus.current = focus.nonce;
    viewRef.current?.scrollTo(
      target.endLine > 0
        ? {
            type: "line",
            id: item.id,
            lineNumber: target.endLine,
            side: target.side === "old" ? "deletions" : "additions",
            align: "center",
          }
        : { type: "item", id: item.id, align: "start" }
    );
  }, [reviewing, focus, placements, items, toolUseId]);

  const selectedRange = selected
    ? selectedLinesFor(selected.fileDiff.name)!
    : null;
  const selectedLines = reviewing
    ? selected
      ? { id: selected.id, range: selectedRange! }
      : null
    : undefined;

  const handleSelectionChange = (next: CodeViewLineSelection | null) => {
    const path = next ? (paths.get(next.id) ?? "") : "";
    const range = next?.range ?? null;

    onSelectionChange(path, range);
  };

  const renderAnnotation = (
    ...args: CodeViewAnnotationArgs<ReviewAnnotation>
  ) => {
    const annotation = args[0];

    return comments.renderAnnotation(annotation);
  };

  return (
    <div
      {...comments.keyboardProps}
      onKeyDown={(event) => {
        revealKeyboardSelection.current =
          event.target === event.currentTarget &&
          ["ArrowDown", "ArrowUp"].includes(event.key);
        comments.keyboardProps.onKeyDown?.(event);
      }}
    >
      <CodeView
        ref={viewRef}
        className="evdiff-scroll"
        style={{ maxHeight }}
        items={items}
        options={options}
        selectedLines={selectedLines}
        onSelectedLinesChange={reviewing ? handleSelectionChange : undefined}
        renderAnnotation={reviewing ? renderAnnotation : undefined}
      />
    </div>
  );
}
