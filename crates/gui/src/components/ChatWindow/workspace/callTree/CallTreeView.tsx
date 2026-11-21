import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { ChangedSymbols, WorktreeChange } from "../../../../bindings";
import type { SymbolGraphRequest } from "../relatedSymbols";
import {
  callTreeDiffs,
  editedLines,
  type CallNode,
  type CallTreeDiff,
  type CallTreeRow,
  type EditedLines,
} from "./model";
import "./callTree.css";

export interface CallSite {
  path: string;
  line: number;
  side: "old" | "new";
}

export interface CallTreeViewProps {
  request: SymbolGraphRequest;
  /** The comparison's files; their patches say which call sites changed. */
  files: readonly WorktreeChange[];
  /** Split shows base and target side by side; unified marks lines +/-. */
  layout: "split" | "unified";
  onJump(site: CallSite): void;
}

type Loaded =
  | { key: string; status: "ready"; changes: ChangedSymbols }
  | { key: string; status: "failed"; message: string };

const ROW = "[data-call-row]";

/** Move between rows with ↑↓; ↵ (a click) opens the call site. */
function onRowsKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(ROW)
  );
  const index = rows.indexOf(document.activeElement as HTMLElement);
  const next =
    rows[event.key === "ArrowDown" ? index + 1 : Math.max(0, index - 1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function Cell({
  node,
  guide,
  change,
  side,
  onJump,
}: {
  node?: CallNode;
  guide: string;
  change: "same" | "added" | "removed" | "fold";
  side: "old" | "new";
  onJump(site: CallSite): void;
}) {
  if (!node) return <div className="call-tree-cell" data-empty="" />;
  return (
    <button
      type="button"
      className="call-tree-cell"
      data-change={change}
      tabIndex={-1}
      title={`${node.path}:${node.line}`}
      onClick={() => onJump({ path: node.path, line: node.line, side })}
    >
      <span className="call-tree-guide">{guide}</span>
      <span className="call-tree-label">{node.label}</span>
      {node.count > 1 && <span className="call-tree-count">×{node.count}</span>}
    </button>
  );
}

const MARK = { same: " ", added: "+", removed: "-" } as const;

function Row({
  row,
  layout,
  onJump,
}: {
  row: CallTreeRow;
  layout: CallTreeViewProps["layout"];
  onJump(site: CallSite): void;
}) {
  if (row.kind === "fold") {
    const text = (
      <span className="call-tree-cell" data-change="fold">
        <span className="call-tree-guide">{row.guide}</span>
        <span className="call-tree-fold">{row.count} unchanged calls</span>
      </span>
    );
    return (
      <div className="call-tree-row" data-layout={layout}>
        {layout === "split" ? (
          <>
            {text}
            {text}
          </>
        ) : (
          <>
            <span className="call-tree-mark" />
            {text}
          </>
        )}
      </div>
    );
  }
  if (layout === "unified") {
    const node = row.target ?? row.base;
    const side = row.target ? "new" : "old";
    return (
      <div
        className="call-tree-row"
        data-layout="unified"
        data-change={row.change}
        data-call-row=""
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Enter" && node)
            onJump({ path: node.path, line: node.line, side });
        }}
      >
        <span className="call-tree-mark" aria-hidden="true">
          {MARK[row.change]}
        </span>
        <Cell
          node={node}
          guide={row.guide}
          change={row.change}
          side={side}
          onJump={onJump}
        />
      </div>
    );
  }
  const primary = row.target ?? row.base;
  // An unchanged call read on one side only still stands on both; it
  // opens where it was read.
  const filled = row.change === "same";
  const base = row.base ?? (filled ? row.target : undefined);
  const target = row.target ?? (filled ? row.base : undefined);
  return (
    <div
      className="call-tree-row"
      data-layout="split"
      data-change={row.change}
      data-call-row=""
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Enter" && primary)
          onJump({
            path: primary.path,
            line: primary.line,
            side: row.target ? "new" : "old",
          });
      }}
    >
      <Cell
        node={base}
        guide={row.guide}
        change={row.change}
        side={row.base ? "old" : "new"}
        onJump={onJump}
      />
      <Cell
        node={target}
        guide={row.guide}
        change={row.change}
        side={row.target ? "new" : "old"}
        onJump={onJump}
      />
    </div>
  );
}

function Tree({
  diff,
  layout,
  onJump,
}: {
  diff: CallTreeDiff;
  layout: CallTreeViewProps["layout"];
  onJump(site: CallSite): void;
}) {
  const root = (side: "old" | "new") => {
    const at = side === "old" ? diff.base : diff.target;
    if (!at) return <div className="call-tree-cell" data-empty="" />;
    return (
      <button
        type="button"
        className="call-tree-cell call-tree-root"
        data-change={diff.change}
        tabIndex={-1}
        title={`${at.path}:${at.line}`}
        onClick={() => onJump({ ...at, side })}
      >
        {diff.label}
      </button>
    );
  };
  const jumpRoot = () => {
    const side = diff.target ? "new" : "old";
    const at = diff.target ?? diff.base;
    if (at) onJump({ ...at, side });
  };
  return (
    <section className="call-tree" aria-label={`Call tree of ${diff.label}`}>
      <div className="call-tree-path">{diff.path}</div>
      <div
        className="call-tree-row"
        data-layout={layout}
        data-change={diff.change}
        data-call-row=""
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Enter") jumpRoot();
        }}
      >
        {layout === "split" ? (
          <>
            {root("old")}
            {root("new")}
          </>
        ) : (
          <>
            <span className="call-tree-mark" aria-hidden="true">
              {MARK[diff.change]}
            </span>
            {root(diff.target ? "new" : "old")}
          </>
        )}
      </div>
      {diff.rows.map((row, index) => (
        <Row key={index} row={row} layout={layout} onJump={onJump} />
      ))}
    </section>
  );
}

/**
 * How the comparison changed who-calls-whom: for each changed entry
 * function, its base calls beside its target calls, aligned, with added
 * and removed calls marked and unchanged ones folded.
 */
export function CallTreeView({
  request,
  files,
  layout,
  onJump,
}: CallTreeViewProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let current = true;
    request.load().then(
      (changes) => {
        if (current) setLoaded({ key: request.key, status: "ready", changes });
      },
      (error: unknown) => {
        if (current)
          setLoaded({
            key: request.key,
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
      }
    );
    return () => {
      current = false;
    };
  }, [request]);
  const state = loaded?.key === request.key ? loaded : null;
  const edits = useMemo(() => {
    const byBase = new Map<string, EditedLines>();
    const byTarget = new Map<string, EditedLines>();
    for (const file of files) {
      const lines = editedLines(file.patch);
      byBase.set(file.old_path ?? file.path, lines);
      byTarget.set(file.path, lines);
    }
    return {
      deleted: (path: string) => byBase.get(path)?.deleted,
      added: (path: string) => byTarget.get(path)?.added,
    };
  }, [files]);
  const diffs = useMemo(
    () =>
      state?.status === "ready" ? callTreeDiffs(state.changes, edits) : [],
    [state, edits]
  );

  if (!state)
    return (
      <p role="status" className="call-tree-status">
        Reading calls…
      </p>
    );
  if (state.status === "failed")
    return (
      <p role="alert" className="call-tree-status">
        {state.message}
      </p>
    );
  if (diffs.length === 0)
    return (
      <p role="status" className="call-tree-status">
        No function's calls changed in this comparison.
      </p>
    );
  return (
    <div
      className="call-tree-view"
      data-layout={layout}
      tabIndex={0}
      aria-label="Call tree changes"
      onKeyDown={onRowsKeyDown}
      onFocus={(event) => {
        if (event.target === event.currentTarget)
          event.currentTarget.querySelector<HTMLElement>(ROW)?.focus();
      }}
    >
      {layout === "split" && (
        <div className="call-tree-columns" aria-hidden="true">
          <span>base</span>
          <span>target</span>
        </div>
      )}
      {state.changes.incomplete && (
        <p role="status" className="call-tree-status">
          Some calls could not be read; the trees may be incomplete.
        </p>
      )}
      {diffs.map((diff) => (
        <Tree key={diff.id} diff={diff} layout={layout} onJump={onJump} />
      ))}
    </div>
  );
}
