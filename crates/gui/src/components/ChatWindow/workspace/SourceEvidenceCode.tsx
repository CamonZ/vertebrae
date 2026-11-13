import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { parseDiffFromFile, type SelectionSide } from "@pierre/diffs";
import {
  CodeView,
  WorkerPoolContext,
  type CodeViewHandle,
  type CodeViewItem,
} from "@pierre/diffs/react";
import {
  usePierreDiffOptions,
  usePierreThemeOptions,
} from "../../../hooks/useCodeAppearance";
import { diffWorkerPool } from "../../thread/toolChange/diffWorkerPool";
import type { ResolvedSource } from "./resolveSource";

export interface SourceEvidenceCodeProps {
  source: Extract<ResolvedSource, { kind: "file" | "diff" }>;
  line?: number;
  endLine?: number;
  side?: "old" | "new";
  /** Changes on every request so a repeated click scrolls again. */
  nonce: number;
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
}: SourceEvidenceCodeProps): ReactNode {
  const fileOptions = usePierreThemeOptions();
  const diffOptions = usePierreDiffOptions();
  const viewRef = useRef<CodeViewHandle<undefined, undefined>>(null);

  const items = useMemo<CodeViewItem<undefined>[]>(
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
                : { name: source.oldPath, contents: source.before },
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

  return (
    <WorkerPoolContext.Provider value={diffWorkerPool}>
      <CodeView
        ref={viewRef}
        className="changes-code-view"
        items={items}
        options={options}
        selectedLines={selectedLines}
      />
    </WorkerPoolContext.Provider>
  );
}
