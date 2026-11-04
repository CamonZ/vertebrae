import type { DiffPreferences } from "../../../utils/codeAppearance";
import { lazy, Suspense, useEffect } from "react";
import type { WorktreeChange } from "../../../bindings";
import {
  currentText,
  isDirty,
  loadBaseline,
  overwriteDocument,
  reloadDocument,
  setDraft,
  setView,
  useDocumentStore,
  type Body,
} from "./documentStore";

const DocumentEditor = lazy(() => import("./DocumentEditor"));

export interface DocumentPaneProps {
  worktreePath: string;
  path: string;
  /** The file's entry in the changes list, when it has one. */
  change: WorktreeChange | undefined;
  baselineCommit: string | null;
  /** Bumped whenever the changes list reloads, so baselines are re-read. */
  changesGeneration: number;
  onSave(path: string): void;
  onSaved(): void;
  diffStyle?: DiffPreferences["diffStyle"];
}

function unavailable(body: Body, side: string): string | null {
  switch (body.kind) {
    case "binary":
      return `Binary ${side} — not shown`;
    case "too_large":
      return `${side} exceeds the 2 MiB edit limit — not shown`;
    case "unreadable":
    case "error":
      return body.message;
    default:
      return null;
  }
}

/** One open worktree file, as complete contents or as an editable diff. */
export function DocumentPane({
  worktreePath,
  path,
  change,
  baselineCommit,
  changesGeneration,
  onSave,
  onSaved,
  diffStyle,
}: DocumentPaneProps) {
  const document = useDocumentStore(
    (state) => state.workspaces[worktreePath]?.documents[path]
  );
  const diffable = change != null && change.marker == null;
  const deleted =
    change?.status === "deleted" && document?.disk.kind === "missing";
  const view = deleted ? "diff" : diffable ? document?.view : "file";
  const sourcePath = change?.old_path ?? path;
  const baselineKey = `${baselineCommit}:${sourcePath}:${changesGeneration}`;

  useEffect(() => {
    if (view === "diff" && baselineCommit) {
      void loadBaseline(
        worktreePath,
        path,
        sourcePath,
        baselineCommit,
        baselineKey
      );
    }
  }, [view, worktreePath, path, sourcePath, baselineCommit, baselineKey]);

  if (!document) return null;
  const dirty = isDirty(document);
  const text = currentText(document);

  let body;
  const diskProblem = unavailable(document.disk, "file");
  if (document.disk.kind === "loading") {
    body = <p role="status">Loading file…</p>;
  } else if (diskProblem) {
    body = <p className="changes-file-fallback">{diskProblem}</p>;
  } else if (document.disk.kind === "missing" && !deleted) {
    body = <p className="changes-file-fallback">This file no longer exists.</p>;
  } else if (view === "diff" && baselineCommit) {
    const baseline = document.baseline?.body ?? { kind: "loading" };
    const baselineProblem = unavailable(baseline, "baseline");
    body =
      baseline.kind === "loading" ? (
        <p role="status">Loading baseline…</p>
      ) : baselineProblem ? (
        <p className="changes-file-fallback">{baselineProblem}</p>
      ) : deleted && baseline.kind !== "text" ? (
        <p className="changes-file-fallback">
          This file is deleted and has no baseline contents.
        </p>
      ) : (
        <Suspense fallback={<p role="status">Loading editor…</p>}>
          <DocumentEditor
            key={`diff:${document.seed}`}
            path={path}
            view="diff"
            diffStyle={diffStyle}
            contents={deleted ? null : text}
            baseline={baseline.kind === "text" ? baseline.contents : null}
            onChange={(next) => setDraft(worktreePath, path, next)}
          />
        </Suspense>
      );
  } else {
    body = (
      <Suspense fallback={<p role="status">Loading editor…</p>}>
        <DocumentEditor
          key={`file:${document.seed}`}
          path={path}
          view="file"
          contents={text}
          baseline={null}
          onChange={(next) => setDraft(worktreePath, path, next)}
        />
      </Suspense>
    );
  }

  return (
    <section
      aria-label={`Document ${path}`}
      className="flex min-h-0 flex-1 flex-col gap-2"
    >
      <div className="document-toolbar">
        <span className="document-path" title={path}>
          {path}
        </span>
        {dirty && (
          <span className="document-dirty" role="status">
            Unsaved
          </span>
        )}
        {diffable && !deleted && (
          <div
            role="group"
            aria-label="Document view"
            className="document-views"
          >
            <button
              type="button"
              aria-pressed={view === "diff"}
              onClick={() => setView(worktreePath, path, "diff")}
            >
              Diff
            </button>
            <button
              type="button"
              aria-pressed={view === "file"}
              onClick={() => setView(worktreePath, path, "file")}
            >
              File
            </button>
          </div>
        )}
        <button
          type="button"
          className="document-save"
          disabled={!dirty || document.saving || document.conflict != null}
          title="Save (⌘S / Ctrl+S)"
          onClick={() => onSave(path)}
        >
          {document.saving ? "Saving…" : "Save"}
        </button>
      </div>
      {document.saveError && <p role="alert">{document.saveError}</p>}
      {document.conflict && (
        <div role="alert" className="document-conflict">
          <span>
            {document.conflict.revision
              ? "This file changed on disk after it was opened. Your unsaved edits are kept."
              : "This file was removed or is no longer text on disk. Your unsaved edits are kept."}
          </span>
          <button
            type="button"
            onClick={() => void reloadDocument(worktreePath, path)}
          >
            Discard edits and reload
          </button>
          {document.conflict.revision && (
            <button
              type="button"
              onClick={() =>
                void overwriteDocument(worktreePath, path).then(
                  (saved) => saved && onSaved()
                )
              }
            >
              Overwrite with my edits
            </button>
          )}
        </div>
      )}
      <div className="document-body">{body}</div>
    </section>
  );
}
