import { useContext, useMemo, type ReactNode } from "react";
import { FileReferenceNavigationContext } from "./FileReferenceNavigationContext";
import { MarkdownFileReference } from "./MarkdownFileReferences";
import { useMarkdownCheckout } from "./markdownReferenceContext";
import {
  parseCallDiff,
  parseCallTree,
  WORKING_TREE,
  type CallEvidence,
  type CallNode,
  type CallRow,
  type FunctionDiff,
} from "./callDiagramSpec";
import "./callDiagram.css";

function Entry({
  node,
  snapshot,
  change,
  root = false,
}: {
  node: CallEvidence;
  snapshot: string;
  change?: "added" | "removed";
  root?: boolean;
}) {
  const checkout = useMarkdownCheckout();
  const openFile = useContext(FileReferenceNavigationContext);
  const location = `${node.path}:${node.line}`;
  const label = <span className="call-diagram-label">{node.label}</span>;
  return (
    <div className="call-diagram-cell" data-change={change} data-root={root || undefined}>
      {change && <span className="sr-only">{change === "added" ? "Added" : "Removed"}</span>}
      {snapshot === WORKING_TREE ? (
        <span title={location}>
          <MarkdownFileReference destination={location} syntax="link" fallback={label}>
            {label}
          </MarkdownFileReference>
        </span>
      ) : checkout && openFile ? (
        <button
          type="button"
          className="call-diagram-source"
          title={location}
          onClick={() =>
            openFile({ root: checkout, path: node.path, line: node.line, column: null, commit: snapshot })
          }
        >
          {label}
        </button>
      ) : (
        <span title={location}>{label}</span>
      )}
      {node.relationship && node.relationship !== "call" && (
        <span className="call-diagram-detail">{node.relationship}</span>
      )}
      {node.certainty && node.certainty !== "verified" && (
        <span className="call-diagram-detail">{node.certainty}</span>
      )}
    </div>
  );
}

function TreeNode({ node, snapshot, root = false }: { node: CallNode; snapshot: string; root?: boolean }) {
  const count = node.children.length;
  return (
    <li>
      <Entry node={node} snapshot={snapshot} root={root} />
      {count > 0 && (
        <details className="call-diagram-branch" open={root}>
          <summary>{count} {count === 1 ? "branch" : "branches"}</summary>
          <ul>
            {node.children.map((child, index) => (
              <TreeNode key={index} node={child} snapshot={snapshot} />
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function SplitRow({
  row,
  base,
  target,
  root = false,
}: {
  row: CallRow;
  base: string;
  target: string;
  root?: boolean;
}) {
  return (
    <div className="call-diagram-split">
      {row.old ? (
        <Entry node={row.old} snapshot={base} root={root} change={root ? undefined : "removed"} />
      ) : (
        <div className="call-diagram-cell" data-empty="" />
      )}
      {row.new ? (
        <Entry node={row.new} snapshot={target} root={root} change={root ? undefined : "added"} />
      ) : (
        <div className="call-diagram-cell" data-empty="" />
      )}
    </div>
  );
}

function FunctionChanges({ row, base, target }: { row: FunctionDiff; base: string; target: string }) {
  return (
    <section className="call-diagram-function" aria-label={row.new?.label ?? row.old?.label}>
      <SplitRow row={row} base={base} target={target} root />
      <ul className="call-diagram-calls">
        {row.children.map((call, index) => (
          <li key={index}><SplitRow row={call} base={base} target={target} /></li>
        ))}
      </ul>
    </section>
  );
}

const snapshotLabel = (snapshot: string) =>
  snapshot === WORKING_TREE ? "Working tree at time of answer" : snapshot.slice(0, 12);

function Frame({ title, scope, incomplete, children }: {
  title: string;
  scope?: string;
  incomplete?: string;
  children: ReactNode;
}) {
  return (
    <figure className="call-diagram">
      <figcaption className="call-diagram-title">
        <span>{title}</span>
        {scope && <span className="call-diagram-range">{scope}</span>}
      </figcaption>
      <div className="call-diagram-body">
        {incomplete && <p role="status">Incomplete · {incomplete}</p>}
        {children}
      </div>
    </figure>
  );
}

export function CallTreeBlock({ source }: { source: string }) {
  const parsed = useMemo(() => parseCallTree(source), [source]);
  if (!parsed.ok)
    return <Frame title="Call tree"><p role="alert">{parsed.message}</p></Frame>;
  const { snapshot, direction, root, incomplete } = parsed.data;
  return (
    <Frame title="Call tree" scope={`${direction} · ${snapshotLabel(snapshot)}`} incomplete={incomplete}>
      <ul><TreeNode node={root} snapshot={snapshot} root /></ul>
    </Frame>
  );
}

export function CallDiffBlock({ source }: { source: string }) {
  const parsed = useMemo(() => parseCallDiff(source), [source]);
  if (!parsed.ok)
    return <Frame title="Call diff"><p role="alert">{parsed.message}</p></Frame>;
  const { base, target, rows, incomplete } = parsed.data;
  return (
    <Frame title="Call diff" incomplete={incomplete}>
      <div className="call-diagram-split call-diagram-columns">
        <span title={base}>Base · {snapshotLabel(base)}</span>
        <span title={target}>Target · {snapshotLabel(target)}</span>
      </div>
      {rows.map((row, index) => (
        <FunctionChanges key={index} row={row} base={base} target={target} />
      ))}
    </Frame>
  );
}
