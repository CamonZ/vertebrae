import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import {
  DEFAULT_DIFF_HEIGHT,
  ResizableDiffViewport,
} from "./ResizableDiffViewport";
import {
  MARKER_TEXT,
  type ChangedFile,
  type WorktreeDelta,
} from "./worktreeDelta";

// Pierre is loaded on first render so it stays out of the main chunk.
const LazyPatchFiles = lazy(() => import("./PatchFiles"));

/** Ensure a bare unified diff has the file headers Pierre's parser expects. */
function toPatch(path: string, diff: string): string {
  if (diff.startsWith("diff --git") || diff.startsWith("--- ")) return diff;
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${diff}`;
}

/** Pierre's default row height, which the placeholder matches. */
const PLAIN_ROW_PX = 20;

/** Patch lines below the file headers, shown verbatim. */
function patchBody(patch: string): string[] {
  return patch
    .split("\n")
    .filter((line) => !/^(diff --git|index |--- |\+\+\+ )/.test(line));
}

/**
 * Unhighlighted patch text, sized like Pierre's rows. Stands in for diffs far
 * from the visible area and while Pierre loads, so long chats only pay for
 * the diffs a user can reach. Only the rows that fit `limit` are laid out;
 * the full height is reserved so scrolling inside stays consistent.
 */
export function PlainPatch({
  patches,
  limit = DEFAULT_DIFF_HEIGHT,
}: {
  patches: string[];
  limit?: number;
}): ReactNode {
  const lines = patches.flatMap(patchBody);
  return (
    <pre
      className="evdiff-plain"
      data-testid="diff-placeholder"
      style={{ height: lines.length * PLAIN_ROW_PX }}
    >
      {lines.slice(0, Math.ceil(limit / PLAIN_ROW_PX)).join("\n")}
    </pre>
  );
}

/** Lazily rendered Pierre diffs inside a resizable, viewport-gated frame. */
function InlineDiffs({ patches }: { patches: string[] }): ReactNode {
  return (
    <ResizableDiffViewport
      placeholder={(limit) => <PlainPatch patches={patches} limit={limit} />}
    >
      <Suspense fallback={<PlainPatch patches={patches} />}>
        {patches.map((patch, i) => (
          <LazyPatchFiles key={i} patch={patch} />
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
}: {
  delta: WorktreeDelta;
  toolName?: ReactNode;
}): ReactNode {
  const n = delta.files.length;
  const hasPatch = delta.patch.trim().length > 0;
  // Pierre's file headers cover files with hunks; list the rest explicitly.
  const listed = hasPatch ? delta.files.filter((f) => f.marker) : delta.files;
  return (
    <section
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
          <span className="evtool-args">by {toolName}</span>
        ) : null}
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
      {hasPatch ? <InlineDiffs patches={[delta.patch]} /> : null}
    </section>
  );
}
