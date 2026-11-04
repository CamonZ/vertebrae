import type { DiffPreferences } from "../../../utils/codeAppearance";
import { lazy, Suspense, useEffect, useState } from "react";
import {
  commands,
  type ComparisonSnapshot,
  type FileBody,
  type WorktreeChange,
} from "../../../bindings";

const DocumentEditor = lazy(() => import("./DocumentEditor"));

/** Historical documents never enter the mutable working-copy draft store. */
export function HistoricalDocument({
  worktreePath,
  path,
  change,
  comparison,
  diffStyle,
}: {
  worktreePath: string;
  path: string;
  change: WorktreeChange | undefined;
  comparison: ComparisonSnapshot;
  diffStyle?: DiffPreferences["diffStyle"];
}) {
  const [view, setView] = useState<"file" | "diff">("diff");
  const [state, setState] = useState<
    { base: FileBody; target: FileBody } | { error: string } | null
  >(null);

  useEffect(() => {
    let current = true;

    setState(null);

    Promise.all([
      commands.readWorktreeBaselineFile(
        worktreePath,
        change?.old_path ?? path,
        comparison.base_commit
      ),
      commands.readWorktreeBaselineFile(
        worktreePath,
        path,
        comparison.target_commit
      ),
    ])
      .then(([base, target]) => {
        if (!current) return;
        if (base.status === "error") setState({ error: base.error.message });
        else if (target.status === "error")
          setState({ error: target.error.message });
        else setState({ base: base.data, target: target.data });
      })
      .catch((error: unknown) => {
        if (current) setState({ error: String(error) });
      });

    return () => {
      current = false;
    };
  }, [
    worktreePath,
    path,
    change?.old_path,
    comparison.base_commit,
    comparison.target_commit,
  ]);

  return (
    <section
      aria-label={`Historical document ${path}`}
      className="flex min-h-0 flex-1 flex-col gap-2"
    >
      <div className="document-toolbar">
        <span className="document-path">{path} · Read-only</span>
        <div role="group" aria-label="Document view" className="document-views">
          {(["diff", "file"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => setView(value)}
            >
              {value === "diff" ? "Diff" : "File"}
            </button>
          ))}
        </div>
      </div>
      {!state ? (
        <p role="status">Loading committed contents…</p>
      ) : "error" in state ? (
        <p role="alert">{state.error}</p>
      ) : [state.base, state.target].some(
          (body) => body.kind !== "text" && body.kind !== "missing"
        ) ? (
        <p role="status">
          Binary, oversized or unreadable committed contents cannot be
          displayed.
        </p>
      ) : (
        <div className="document-body">
          <Suspense fallback={<p role="status">Loading editor…</p>}>
            <DocumentEditor
              key={view}
              path={path}
              view={view}
              diffStyle={diffStyle}
              contents={
                state.target.kind === "text" ? state.target.contents : null
              }
              baseline={state.base.kind === "text" ? state.base.contents : null}
              readOnly
              onChange={() => {}}
            />
          </Suspense>
        </div>
      )}
    </section>
  );
}
