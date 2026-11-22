import {
  FULL_FILE_SELECTION_LABEL,
  useFullFileDiscussion,
} from "./useFullFileDiscussion";
import type { ReviewAnnotation } from "../../thread/toolChange/DiffCommentThread";
import type { FullFileSource } from "../selectionDiscussions";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseDiffFromFile, type SelectionSide } from "@pierre/diffs";
import {
  CodeView,
  WorkerPoolContext,
  type CodeViewAnnotationArgs,
  type CodeViewHandle,
  type CodeViewItem,
} from "@pierre/diffs/react";
import {
  usePierreDiffOptions,
  usePierreThemeOptions,
} from "../../../hooks/useCodeAppearance";
import { DIFF_CURSOR_HOST_ATTRIBUTE } from "../../thread/toolChange/diffCursor";
import { diffWorkerPool } from "../../thread/toolChange/diffWorkerPool";
import type { ResolvedSource } from "./resolveSource";

export interface SourceEvidenceCodeProps {
  source: Extract<ResolvedSource, { kind: "file" | "diff" }>;
  line?: number;
  endLine?: number;
  side?: "old" | "new";
  /** Changes on every request so a repeated click scrolls again. */
  nonce: number;
  discussionSource?: FullFileSource;
}

/**
 * One read-only file or diff with the evidence lines selected and scrolled
 * into view. Unchanged regions stay expanded so referenced context lines
 * exist. Loaded lazily so Pierre stays out of the main chunk.
 */
export default function SourceEvidenceCode({
  source,
  line,
  endLine,
  side,
  nonce,
  discussionSource,
}: SourceEvidenceCodeProps): ReactNode {
  const fileOptions = usePierreThemeOptions();
  const diffOptions = usePierreDiffOptions();
  const viewRef = useRef<CodeViewHandle<ReviewAnnotation, undefined>>(null);

  const items = useMemo<CodeViewItem<ReviewAnnotation>[]>(
    () => [
      source.kind === "file"
        ? {
            id: source.path,
            type: "file",
            file: { name: source.path, contents: source.contents },
          }
        : {
            id: source.path,
            type: "diff",
            fileDiff: parseDiffFromFile(
              source.before == null
                ? null
                : { name: source.path, contents: source.before },
              source.after == null
                ? null
                : { name: source.path, contents: source.after }
            ),
          },
    ],
    [source]
  );
  const options = useMemo(
    () =>
      source.kind === "diff"
        ? { ...diffOptions, expandUnchanged: true }
        : fileOptions,
    [source.kind, diffOptions, fileOptions]
  );

  // Only one side exists for added and deleted files.
  const lineSide: SelectionSide | undefined =
    source.kind === "file"
      ? undefined
      : source.status === "added"
        ? "additions"
        : source.status === "deleted"
          ? "deletions"
          : side === "old"
            ? "deletions"
            : "additions";
  const id = source.path;
  const selectedLines =
    line !== undefined
      ? {
          id,
          range: {
            start: line,
            end: endLine ?? line,
            ...(lineSide ? { side: lineSide, endSide: lineSide } : {}),
          },
        }
      : null;

  const discussion = useFullFileDiscussion(
    source.kind === "file" ? discussionSource : undefined,
    id,
    source.kind === "file" ? source.contents : null,
    selectedLines?.range ?? null,
    false,
    (lineNumber) =>
      viewRef.current?.scrollTo({
        type: "line",
        id,
        lineNumber,
        align: "nearest",
        behavior: "instant",
      })
  );
  const signature = JSON.stringify(discussion.annotations);
  const [revision, setRevision] = useState({ signature, source, version: 0 });
  if (revision.signature !== signature || revision.source !== source)
    setRevision({ signature, source, version: revision.version + 1 });

  useEffect(() => {
    viewRef.current?.scrollTo(
      line !== undefined
        ? {
            type: "line",
            id,
            lineNumber: line,
            ...(lineSide ? { side: lineSide } : {}),
            align: "center",
          }
        : { type: "item", id, align: "start" }
    );
  }, [nonce, items, id, line, lineSide]);

  const item = items[0];
  const view = (
    <WorkerPoolContext.Provider value={diffWorkerPool}>
      <CodeView
        ref={viewRef}
        className="changes-code-view"
        items={
          discussion.enabled && item.type === "file"
            ? [
                {
                  ...item,
                  annotations: discussion.annotations,
                  version: revision.version,
                },
              ]
            : items
        }
        options={
          discussion.enabled
            ? {
                ...options,
                ...discussion.options,
                unsafeCSS: `${options.unsafeCSS ?? ""}\n${discussion.annotationCSS}`,
              }
            : options
        }
        selectedLines={
          discussion.enabled
            ? discussion.range && { id, range: discussion.range }
            : selectedLines
        }
        renderAnnotation={
          discussion.enabled
            ? (...[annotation]: CodeViewAnnotationArgs<ReviewAnnotation>) =>
                discussion.renderAnnotation(annotation)
            : undefined
        }
      />
    </WorkerPoolContext.Provider>
  );

  return discussion.enabled ? (
    <div
      ref={discussion.focus}
      tabIndex={0}
      role="group"
      {...{ [DIFF_CURSOR_HOST_ATTRIBUTE]: "file" }}
      data-focus-halo="overlay"
      className="diff-line-cursor-host diff-line-cursor-host--changes flex min-h-0 flex-1 flex-col"
      aria-label={FULL_FILE_SELECTION_LABEL}
      onKeyDown={discussion.onKeyDown}
    >
      {discussion.reason && <p role="alert">{discussion.reason}</p>}
      {view}
    </div>
  ) : (
    view
  );
}
