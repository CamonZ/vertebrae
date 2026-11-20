import { useCallback, useMemo } from "react";
import type { ReviewDiffAnnotation } from "../../../hooks/useDiffComments";
import type { ReviewAnnotation } from "../../thread/toolChange/DiffCommentThread";
import type { Reveals } from "../../thread/toolChange/diffGaps";
import type { DiffSide, SemanticHunks, SemanticLabel } from "./semanticHunks";
import type { ChangeFiles, SemanticFile } from "./useChangeFiles";

/** Annotation metadata for a line that carries only a semantic label. */
const LABEL_ONLY: ReviewAnnotation = {
  commentIds: [],
  draft: false,
  labelOnly: true,
};

export interface SemanticMode {
  on: boolean;
  /** The file's semantic view or line-diff reason; null while loading or off. */
  fileFor(path: string): SemanticFile | null;
  viewFor(path: string): SemanticHunks | undefined;
  /** `off`, `pending` until the file's result (and its labels) arrive, or `ready`. */
  status(path: string): "off" | "pending" | "ready";
  /** Lines revealed so each hunk opens at its declaration, per path. */
  autoReveals: Reveals;
  labelAt(
    path: string,
    side: DiffSide,
    lineNumber: number
  ): SemanticLabel | undefined;
  /**
   * A file's review annotations plus a label-only annotation for each
   * semantic label on a line without one (a line with comments renders both).
   */
  annotate(
    path: string,
    review: ReviewDiffAnnotation[]
  ): ReviewDiffAnnotation[];
}

/** Semantic mode's view of the loaded files in Changes. */
export function useSemanticMode(
  files: ChangeFiles,
  /** The files shown, by path. */
  paths: ReadonlyMap<string, unknown>,
  on: boolean
): SemanticMode {
  const { fileFor: loadedFor } = files;
  const fileFor = useCallback(
    (path: string) => (on ? (loadedFor(path)?.semantic ?? null) : null),
    [on, loadedFor]
  );
  const viewFor = useCallback(
    (path: string) => {
      const file = fileFor(path);
      return file?.status === "semantic" ? file.view : undefined;
    },
    [fileFor]
  );
  const status = useCallback(
    (path: string) => (!on ? "off" : fileFor(path) ? "ready" : "pending"),
    [on, fileFor]
  );
  const autoReveals = useMemo(() => {
    const reveals = new Map<string, SemanticHunks["reveals"]>();
    for (const path of paths.keys()) {
      const view = viewFor(path);
      if (view) reveals.set(path, view.reveals);
    }
    return reveals;
  }, [paths, viewFor]);
  const labelAt = useCallback(
    (path: string, side: DiffSide, lineNumber: number) =>
      viewFor(path)?.labels.find(
        (label) => label.side === side && label.lineNumber === lineNumber
      ),
    [viewFor]
  );
  const annotate = useCallback(
    (path: string, review: ReviewDiffAnnotation[]) => {
      const labels = viewFor(path)?.labels;
      if (!labels?.length) return review;
      const taken = new Set(review.map((a) => `${a.side}:${a.lineNumber}`));
      const extra = labels
        .filter((label) => !taken.has(`${label.side}:${label.lineNumber}`))
        .map((label) => ({
          side: label.side,
          lineNumber: label.lineNumber,
          metadata: LABEL_ONLY,
        }));
      return extra.length ? [...review, ...extra] : review;
    },
    [viewFor]
  );
  return useMemo(
    () => ({ on, fileFor, viewFor, status, autoReveals, labelAt, annotate }),
    [on, fileFor, viewFor, status, autoReveals, labelAt, annotate]
  );
}
