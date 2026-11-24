import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useToolAnnotation } from "../../../hooks/useToolAnnotation";
import { SegmentedControl } from "../../molecules/SegmentedControl";
import type { FileTarget } from "../../shared/FileReferenceNavigationContext";
import type { FileReveal } from "./sourceRoute";
import { OpenInExternalEditor } from "./OpenInExternalEditor";
import { resolveTurnSource, type TurnSource } from "./resolveTurnSource";

const SourceEvidenceCode = lazy(() => import("./SourceEvidenceCode"));
export type TurnDocumentVersion = "turn" | "latest";

const versions = [
  { value: "turn", label: "At this turn" },
  { value: "latest", label: "Latest file" },
] as const;

export interface TurnDocumentTarget {
  path: string;
  root: string | null;
  column?: number;
  reveal: FileReveal | null;
  history: NonNullable<FileTarget["history"]>;
}

export function TurnDocument({
  target,
  version,
  onVersionChange,
  onClose,
}: {
  target: TurnDocumentTarget;
  version: TurnDocumentVersion;
  onVersionChange(version: TurnDocumentVersion): void;
  onClose(): void;
}) {
  const { path, root, history, reveal } = target;
  const turnId = history.turnId;
  const capture = useToolAnnotation(
    history.sessionId,
    history.turnId ? JSON.stringify(["turn", history.turnId]) : null,
    "worktree_history"
  );
  const [retry, setRetry] = useState(0);
  const latest = version === "latest";
  // A newly published capture refreshes a pending historical read.
  const captureRevision = latest ? null : capture;
  const requestKey = useMemo(
    () => ({ root, version, retry, captureRevision, history, path }),
    [root, version, retry, captureRevision, history, path]
  );
  const [loaded, setLoaded] = useState<{
    key: typeof requestKey;
    source: TurnSource;
  } | null>(null);

  useEffect(() => {
    let current = true;
    void resolveTurnSource(root ?? "", path, history, latest).then(
      (source) => {
        if (current) setLoaded({ key: requestKey, source });
      },
      (error: unknown) => {
        if (current) {
          setLoaded({
            key: requestKey,
            source: {
              kind: "unavailable",
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
            },
          });
        }
      }
    );
    return () => {
      current = false;
    };
  }, [requestKey, root, path, history, latest]);

  const source = loaded?.key === requestKey ? loaded.source : null;
  return (
    <section
      aria-label={`File ${path}`}
      data-changes-path={path}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
    >
      <div className="document-toolbar">
        <span className="document-path" title={path}>
          {path}
        </span>
        <SegmentedControl
          ariaLabel="File version"
          options={versions}
          value={version}
          onChange={onVersionChange}
        />
        {latest && root && (
          <OpenInExternalEditor
            root={root}
            path={path}
            line={reveal?.line}
            column={target.column}
            available={source?.kind === "file"}
          />
        )}
        <button
          type="button"
          className="changes-tab-close"
          title="Close file reference"
          aria-label="Close file reference"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {!source ? (
        <p role="status">Loading file contents…</p>
      ) : source.kind === "unavailable" ? (
        <div className="changes-file-fallback">
          <p role="status">{source.message}</p>
          {source.retryable && (
            <button
              type="button"
              className="evidence-action"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="text-secondary text-fg-mute">{source.note}</p>
          <div className="changes-viewport">
            <Suspense fallback={<p role="status">Loading viewer…</p>}>
              <SourceEvidenceCode
                key={JSON.stringify([
                  root,
                  history.sessionId,
                  history.turnId,
                  version,
                  path,
                  retry,
                ])}
                source={source}
                discussionSource={
                  root && latest
                    ? { checkout: root, turn: null }
                    : root && turnId
                      ? {
                          checkout: root,
                          turn: { sessionId: history.sessionId, turnId },
                        }
                      : undefined
                }
                line={reveal?.line}
                endLine={reveal?.endLine}
                nonce={reveal?.nonce ?? 0}
              />
            </Suspense>
          </div>
        </>
      )}
    </section>
  );
}
