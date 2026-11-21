import { OpenInExternalEditor } from "./OpenInExternalEditor";
import { lazy, Suspense, useEffect, useState } from "react";
import type { SourceLocation } from "../../shared/EvidenceNavigationContext";
import {
  resolveSource,
  shortRevision,
  type ResolvedSource,
  type SourceRevision,
} from "./resolveSource";
import "./evidencePanel.css";

const SourceEvidenceCode = lazy(() => import("./SourceEvidenceCode"));

export interface EvidenceTarget extends SourceLocation {
  /** Distinguishes repeated opens of the same location. */
  nonce: number;
  revision: SourceRevision;
}

type LoadState =
  | { key: string; source: ResolvedSource }
  | { key: string; error: string };

const lineSuffix = ({ line, endLine }: SourceLocation) =>
  line ? `:${line}${endLine && endLine !== line ? `–${endLine}` : ""}` : "";

/**
 * Read-only Pierre view of flow code evidence that the Changes workspace
 * cannot show directly: an explicit commit or revision range.
 */
export function SourceEvidence({
  checkout,
  target,
  onClose,
}: {
  checkout: string;
  target: EvidenceTarget;
  onClose(): void;
}) {
  const { path, revision } = target;
  const commit = revision.kind === "commit" ? revision.commit : undefined;
  const [reload, setReload] = useState(0);
  const key = JSON.stringify([checkout, path, revision, reload, target.nonce]);
  const [state, setState] = useState<LoadState | null>(null);

  useEffect(() => {
    let current = true;
    const request = resolveSource(checkout, path, revision);
    request.then(
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
  }, [key, checkout, path, revision]);

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
        {source?.kind === "unavailable" && source.retryable && (
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            Retry
          </button>
        )}
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
        {!commit && (
          <OpenInExternalEditor
            root={checkout}
            path={path}
            line={target.line}
            column={target.column}
            available={shown?.kind === "file"}
          />
        )}
        {shown?.kind === "diff" && (
          <span className={`evidence-status is-${shown.status}`}>
            {shown.status}
          </span>
        )}
        <span className="document-path" title={path}>
          {path}
          {lineSuffix(target)}
        </span>
        {shown?.kind === "diff" && (
          <span className="evidence-revisions">{shown.label}</span>
        )}
        {commit && (
          <span className="evidence-revisions" title={commit}>
            {shortRevision(commit)}
          </span>
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
