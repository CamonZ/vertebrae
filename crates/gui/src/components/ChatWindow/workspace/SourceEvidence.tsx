import { lazy, Suspense, useEffect, useState } from "react";
import type { SourceLocation } from "../../shared/EvidenceNavigationContext";
import { resolveSource, type ResolvedSource } from "./resolveSource";
import "./evidencePanel.css";

const SourceEvidenceCode = lazy(() => import("./SourceEvidenceCode"));

export interface EvidenceTarget extends SourceLocation {
  /** Distinguishes repeated opens of the same location. */
  nonce: number;
}

type LoadState =
  | { key: string; source: ResolvedSource }
  | { key: string; error: string };

const lineSuffix = ({ line, endLine }: SourceLocation) =>
  line ? `:${line}${endLine && endLine !== line ? `–${endLine}` : ""}` : "";

/**
 * Read-only Pierre view of a flow's code evidence in the conversation's
 * checkout: the file at the referenced lines, or its diff when it changed
 * or the evidence names a revision range.
 */
export function SourceEvidence({
  checkout,
  target,
  onClose,
  onOpenInChanges,
}: {
  checkout: string;
  target: EvidenceTarget;
  onClose(): void;
  /** Offered when the checkout is the conversation's own worktree. */
  onOpenInChanges?: () => void;
}) {
  const { path, base, head } = target;
  const [reload, setReload] = useState(0);
  const key = JSON.stringify([checkout, path, base, head, reload]);
  const [state, setState] = useState<LoadState | null>(null);

  useEffect(() => {
    let current = true;
    resolveSource(checkout, { path, base, head }).then(
      (source) => current && setState({ key, source }),
      (error: unknown) =>
        current &&
        setState({
          key,
          error: error instanceof Error ? error.message : String(error),
        })
    );
    return () => {
      current = false;
    };
  }, [key, checkout, path, base, head]);

  const loaded = state?.key === key ? state : null;
  const source = loaded && "source" in loaded ? loaded.source : null;
  const shown = source && source.kind !== "unavailable" ? source : null;

  let body;
  if (!loaded) body = <p role="status">Loading source…</p>;
  else if ("error" in loaded)
    body = (
      <p role="alert">
        {loaded.error}{" "}
        <button type="button" onClick={() => setReload((value) => value + 1)}>
          Retry
        </button>
      </p>
    );
  else if (!shown)
    body = (
      <p role="status" className="changes-file-fallback">
        {source?.kind === "unavailable" ? source.message : null}
      </p>
    );
  else
    body = (
      <div className="changes-viewport">
        <Suspense fallback={<p role="status">Loading viewer…</p>}>
          <SourceEvidenceCode
            source={shown}
            line={target.line}
            endLine={target.endLine}
            side={target.side}
            nonce={target.nonce}
          />
        </Suspense>
      </div>
    );

  return (
    <section
      aria-label={`Evidence ${path}`}
      className="flex min-h-0 flex-1 flex-col gap-2 p-3 text-sm"
    >
      <div className="document-toolbar">
        {shown?.kind === "diff" && (
          <span className={`evidence-status is-${shown.status}`}>
            {shown.status}
          </span>
        )}
        <span
          className="document-path"
          title={shown?.kind === "diff" ? shown.path : path}
        >
          {shown?.kind === "diff" && shown.oldPath !== shown.path
            ? `${shown.oldPath} → ${shown.path}`
            : path}
          {lineSuffix(target)}
        </span>
        {shown?.kind === "diff" && (
          <span className="evidence-revisions">{shown.label}</span>
        )}
        {onOpenInChanges && (
          <button
            type="button"
            className="evidence-action"
            onClick={onOpenInChanges}
          >
            Open in Changes
          </button>
        )}
        <button
          type="button"
          className="evidence-action"
          aria-label="Close evidence"
          title="Close evidence"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {shown?.kind === "file" && shown.note && (
        <p role="status">{shown.note}</p>
      )}
      {body}
    </section>
  );
}
