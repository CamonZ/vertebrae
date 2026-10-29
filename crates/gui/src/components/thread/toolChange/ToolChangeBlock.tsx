import { lazy, Suspense, useContext, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useToolAnnotation } from "../../../hooks/useToolAnnotation";
import { ChatSessionContext } from "./ChatSessionContext";
import {
  MARKER_TEXT,
  parseWorktreeDelta,
  type ChangedFile,
} from "./worktreeDelta";

// Pierre is loaded on first expand so it stays out of the main chunk.
const LazyPatchFiles = lazy(() => import("./PatchFiles"));

/** Ensure a bare unified diff has the file headers Pierre's parser expects. */
function toPatch(path: string, diff: string): string {
  if (diff.startsWith("diff --git") || diff.startsWith("--- ")) return diff;
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${diff}`;
}

/** Pierre rendering of diffs carried by the tool payload itself. */
export function PayloadDiffs({
  diffs,
}: {
  diffs: { path: string; diff: string }[];
}): ReactNode {
  return (
    <Suspense fallback={<div className="evtool-sum">Loading diff…</div>}>
      {diffs.map((d, i) => (
        <LazyPatchFiles
          key={`${i}:${d.path}`}
          patch={toPatch(d.path, d.diff)}
        />
      ))}
    </Suspense>
  );
}

function fileLabel(f: ChangedFile): string {
  return f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
}

export function FileChangeSummary({ file }: { file: ChangedFile }): ReactNode {
  return (
    <>
      <span className="font-mono">{fileLabel(file)}</span>{" "}
      <span>({file.status})</span>
      {file.additions !== undefined && file.deletions !== undefined ? (
        <span>
          {" "}
          +{file.additions} −{file.deletions}
        </span>
      ) : null}
      {file.marker ? <span> — {MARKER_TEXT[file.marker]}</span> : null}
    </>
  );
}

/**
 * Compact per-tool-call worktree change summary that expands to the diff.
 * Renders nothing without a usable recorded delta.
 */
export function ToolChangeBlock({
  toolId,
}: {
  toolId: string | undefined;
}): ReactNode {
  const sessionId = useContext(ChatSessionContext);
  const annotation = useToolAnnotation(sessionId, toolId, "worktree_delta");
  const delta = useMemo(
    () => (annotation ? parseWorktreeDelta(annotation.payload) : null),
    [annotation]
  );
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!annotation) return null;
  if (!delta) {
    return (
      <div className="evtool-sum" role="status">
        Recorded change could not be displayed
      </div>
    );
  }
  const n = delta.files.length;
  const hasPatch = delta.patch.trim().length > 0;
  return (
    <div className="evtool has-body" data-testid="tool-change-block">
      <button
        type="button"
        className="evtool-hd"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="evtool-name">
          {n} {n === 1 ? "file" : "files"} changed
        </span>
        {delta.aggregate ? (
          <span className="evtool-sum">includes subagent work</span>
        ) : null}
        {delta.overlapping ? (
          <span className="evtool-sum">overlaps other calls — approximate</span>
        ) : null}
        <span className="evtool-chev">▾</span>
      </button>
      {open ? (
        <div className="evtool-bd" id={panelId}>
          <ul>
            {delta.files.map((f) => (
              <li
                key={`${f.oldPath ?? ""}>${f.path}`}
                data-testid="tool-change-file"
              >
                <FileChangeSummary file={f} />
              </li>
            ))}
          </ul>
          {hasPatch ? (
            <Suspense
              fallback={<div className="evtool-sum">Loading diff…</div>}
            >
              <LazyPatchFiles patch={delta.patch} />
            </Suspense>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
