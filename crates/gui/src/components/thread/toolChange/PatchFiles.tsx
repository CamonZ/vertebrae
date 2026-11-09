import { useMemo } from "react";
import type { ReactNode } from "react";
import { FileDiff, WorkerPoolContext } from "@pierre/diffs/react";
import { usePierreDiffOptions } from "../../../hooks/useCodeAppearance";
import { useDiffComments } from "../../../hooks/useDiffComments";
import { diffWorkerPool } from "./diffWorkerPool";
import { useBackgroundTask } from "../../../background/useBackgroundTask";
import type { BackgroundTask } from "../../../background/types";
import { preparePatches } from "./preparePatches";
import { InlinePatchView } from "./InlinePatchView";
import { PlainPatch } from "./PlainPatch";

const NO_REVIEW_FILES: ReturnType<
  typeof preparePatches
>[number]["reviewFiles"] = [];

/** The recorded tool call a patch belongs to; enables line comments. */
export interface PatchReview {
  toolUseId: string;
  toolName?: string;
}

/**
 * Render every file diff in a Git patch. Pierre's `PatchDiff` throws unless
 * the patch holds exactly one file, so split it and render each file. Loaded
 * lazily so Pierre stays out of the main chunk.
 */
export default function PatchFiles({
  patch,
  review,
  maxHeight,
}: {
  patch: string;
  review?: PatchReview;
  /** Supplied by the inline frame; CodeView owns scrolling within this ceiling. */
  maxHeight?: number;
}): ReactNode {
  const options = usePierreDiffOptions();
  const wantsReview = review !== undefined;
  const task = useMemo<Extract<BackgroundTask, { kind: "patch" }>>(
    () => ({ kind: "patch", patches: [patch], review: wantsReview }),
    [patch, wantsReview]
  );

  const prepared = useBackgroundTask(task, preparePatches);
  const files = prepared.value?.[0]?.files;
  const patchFiles = prepared.value?.[0]?.reviewFiles ?? NO_REVIEW_FILES;

  const comments = useDiffComments(
    { kind: "tool_call", toolUseId: review?.toolUseId ?? "" },
    patchFiles,
    review?.toolName
  );
  const { openComposer, onSelectionChange, selectedLinesFor } = comments;
  const reviewing = comments.enabled && review !== undefined;
  const fileOptions = useMemo(
    () =>
      (files ?? []).map((file) =>
        reviewing
          ? {
              ...options,
              enableGutterUtility: true,
              onGutterUtilityClick: (
                range: Parameters<typeof openComposer>[1]
              ) => openComposer(file.name, range),
              // Click, drag or shift-click line numbers to select a range,
              // then choose an explicit action for that selection.
              enableLineSelection: true,
              onLineSelectionEnd: (
                range: Parameters<typeof openComposer>[1] | null
              ) => onSelectionChange(file.name, range),
            }
          : options
      ),
    [files, options, reviewing, openComposer, onSelectionChange]
  );

  if (prepared.pending) {
    return <PlainPatch patches={[patch]} limit={maxHeight} />;
  }

  if (prepared.error) {
    return (
      <div role="alert">
        Diff preparation failed: {prepared.error}{" "}
        <button type="button" onClick={prepared.retry}>
          Retry
        </button>
      </div>
    );
  }

  if (!files) {
    return <div className="evtool-sum">Diff could not be displayed</div>;
  }

  if (maxHeight !== undefined) {
    return (
      <WorkerPoolContext.Provider value={diffWorkerPool}>
        <InlinePatchView
          files={files}
          comments={comments}
          reviewing={reviewing}
          toolUseId={review?.toolUseId}
          maxHeight={maxHeight}
        />
      </WorkerPoolContext.Provider>
    );
  }

  return (
    <WorkerPoolContext.Provider value={diffWorkerPool}>
      <div {...comments.keyboardProps}>
        {files.map((file, i) => (
          <FileDiff
            key={`${i}:${file.prevName ?? ""}>${file.name}`}
            fileDiff={file}
            options={fileOptions[i]}
            {...(reviewing
              ? {
                  lineAnnotations: comments.annotationsFor(file.name),
                  selectedLines: selectedLinesFor(file.name),
                  renderAnnotation: comments.renderAnnotation,
                }
              : {})}
          />
        ))}
      </div>
    </WorkerPoolContext.Provider>
  );
}
