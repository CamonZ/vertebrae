import { PlainPatch } from "./PlainPatch";
import { lazy, Suspense, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { ResizableDiffViewport } from "./ResizableDiffViewport";
import { DiffReviewContext } from "./DiffReviewContext";
import {
  MARKER_TEXT,
  type ChangedFile,
  type WorktreeDelta,
} from "./worktreeDelta";

// Pierre is loaded on first render so it stays out of the main chunk.
const LazyPatchFiles = lazy(() => import("./PatchFiles"));

export { PlainPatch } from "./PlainPatch";

/** Ensure a bare unified diff has the file headers Pierre's parser expects. */
function toPatch(path: string, diff: string): string {
  if (diff.startsWith("diff --git") || diff.startsWith("--- ")) return diff;
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${diff}`;
}

/** Lazily rendered Pierre diffs inside a resizable, viewport-gated frame. */
function InlineDiffs({
  patches,
  review,
}: {
  patches: string[];
  review?: { toolUseId: string; toolName?: string };
}): ReactNode {
  return (
    <ResizableDiffViewport
      placeholder={(limit) => <PlainPatch patches={patches} limit={limit} />}
    >
      <Suspense fallback={<PlainPatch patches={patches} />}>
        {patches.map((patch, i) => (
          <LazyPatchFiles key={i} patch={patch} review={review} />
        ))}
      </Suspense>
    </ResizableDiffViewport>
  );
}

/** Pierre rendering of diffs carried by the tool payload itself. */
export function PayloadDiffs({
  diffs,
}: {
  diffs: { path: string; diff: string }[];
}): ReactNode {
  return <InlineDiffs patches={diffs.map((d) => toPatch(d.path, d.diff))} />;
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

export function ChangeUnavailable(): ReactNode {
  return (
    <div className="evtool-sum" role="status">
      Recorded change could not be displayed
    </div>
  );
}

/**
 * A tool call's worktree changes, shown in place of the call itself: a
 * one-line attribution header followed by the diff.
 */
export function ToolChangeBlock({
  delta,
  toolName,
  toolId,
}: {
  delta: WorktreeDelta;
  toolName?: ReactNode;
  /** Provider tool-call id; enables line comments on this call's patch. */
  toolId?: string;
}): ReactNode {
  const sectionRef = useRef<HTMLElement>(null);
  const review = useContext(DiffReviewContext);
  const focusId = review?.focus?.commentId;
  const focusNonce = review?.focus?.nonce;
  const placements = review?.placements;
  // Bring a requested comment's diff into view; the comment itself scrolls
  // into view once the near-viewport diff has mounted.
  useEffect(() => {
    if (focusNonce === undefined || !toolId) return;
    const here = placements?.some(
      (placement) =>
        placement.commentId === focusId &&
        placement.surface.kind === "tool_call" &&
        placement.surface.toolUseId === toolId
    );
    if (here) sectionRef.current?.scrollIntoView?.({ block: "center" });
    // Only a new request should scroll, not later placement changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);
  const n = delta.files.length;
  const hasPatch = delta.patch.trim().length > 0;
  // Pierre's file headers cover files with hunks; list the rest explicitly.
  const listed = hasPatch ? delta.files.filter((f) => f.marker) : delta.files;
  return (
    <section
      ref={sectionRef}
      className="evtool has-body evchange"
      data-testid="tool-change-block"
      aria-label="Worktree changes"
    >
      <div className="evtool-hd">
        <span className="evtool-dot" />
        <span className="evtool-name">
          {n} {n === 1 ? "file" : "files"} changed
        </span>
        {toolName != null ? (
          <span className="evtool-args">recorded around {toolName}</span>
        ) : null}
        <span className="evtool-sum">
          worktree observation · cause not established
        </span>
        {delta.aggregate ? (
          <span className="evtool-sum">includes subagent work</span>
        ) : null}
        {delta.overlapping ? (
          <span className="evtool-sum">overlaps other calls — approximate</span>
        ) : null}
      </div>
      {listed.length > 0 ? (
        <ul className="evchange-files">
          {listed.map((f) => (
            <li
              key={`${f.oldPath ?? ""}>${f.path}`}
              data-testid="tool-change-file"
            >
              <FileChangeSummary file={f} />
            </li>
          ))}
        </ul>
      ) : null}
      {hasPatch ? (
        <InlineDiffs
          patches={[delta.patch]}
          review={
            toolId
              ? {
                  toolUseId: toolId,
                  ...(typeof toolName === "string" ? { toolName } : {}),
                }
              : undefined
          }
        />
      ) : null}
    </section>
  );
}
