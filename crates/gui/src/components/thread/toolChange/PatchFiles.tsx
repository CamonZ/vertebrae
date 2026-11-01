import { useMemo } from "react";
import type { ReactNode } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, WorkerPoolContext } from "@pierre/diffs/react";
import { usePierreDiffOptions } from "../../../hooks/useCodeAppearance";
import { useDiffComments } from "../../../hooks/useDiffComments";
import { diffWorkerPool } from "./diffWorkerPool";
import { parsePatch } from "./diffLineMapper";

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
}: {
  patch: string;
  review?: PatchReview;
}): ReactNode {
  const options = usePierreDiffOptions();
  const files = useMemo(() => {
    try {
      return parsePatchFiles(patch).flatMap((p) => p.files);
    } catch {
      return null;
    }
  }, [patch]);
  const patchFiles = useMemo(
    () => (review ? parsePatch(patch) : []),
    [patch, review]
  );
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
              // then press the gutter "+" to comment on all of it.
              enableLineSelection: true,
              onLineSelectionEnd: (
                range: Parameters<typeof openComposer>[1] | null
              ) => onSelectionChange(file.name, range),
            }
          : options
      ),
    [files, options, reviewing, openComposer, onSelectionChange]
  );
  if (!files) {
    return <div className="evtool-sum">Diff could not be displayed</div>;
  }
  return (
    <WorkerPoolContext.Provider value={diffWorkerPool}>
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
    </WorkerPoolContext.Provider>
  );
}
