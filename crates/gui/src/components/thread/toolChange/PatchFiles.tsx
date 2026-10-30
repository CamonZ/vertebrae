import { useMemo } from "react";
import type { ReactNode } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, WorkerPoolContext } from "@pierre/diffs/react";
import { diffWorkerPool } from "./diffWorkerPool";

/**
 * Render every file diff in a Git patch. Pierre's `PatchDiff` throws unless
 * the patch holds exactly one file, so split it and render each file. Loaded
 * lazily so Pierre stays out of the main chunk.
 */
export default function PatchFiles({ patch }: { patch: string }): ReactNode {
  const files = useMemo(() => {
    try {
      return parsePatchFiles(patch).flatMap((p) => p.files);
    } catch {
      return null;
    }
  }, [patch]);
  if (!files) {
    return <div className="evtool-sum">Diff could not be displayed</div>;
  }
  return (
    <WorkerPoolContext.Provider value={diffWorkerPool}>
      {files.map((file, i) => (
        <FileDiff
          key={`${i}:${file.prevName ?? ""}>${file.name}`}
          fileDiff={file}
          options={{ diffStyle: "unified" }}
        />
      ))}
    </WorkerPoolContext.Provider>
  );
}
