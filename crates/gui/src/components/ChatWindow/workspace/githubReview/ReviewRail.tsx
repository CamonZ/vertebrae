import { useId, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { GithubFailure } from "../../../../bindings";
import { Spinner } from "../../../Spinner";
import {
  useChecksFreshness,
  type WorktreePr,
} from "../../../../hooks/useWorktreePr";
import { GitHubGlyph } from "../../GithubPr";
import { CheckCounts, PrChecksList } from "../PrChecks";
import { GithubFailureText } from "../PrFailure";
import { GithubThreadCard } from "./GithubThreadCard";
import {
  authorOf,
  firstLine,
  lineLabel,
  type GithubReviewModel,
} from "./model";
import {
  REVIEW_ENTRY_ATTRIBUTE,
  type RailThreads,
} from "./useReviewController";
import "./githubReview.css";

/** A heading's `·`, spaced by CSS rather than by the font's spaces. */
function Separator() {
  return (
    <span className="gh-sep" aria-hidden="true">
      ·
    </span>
  );
}

function fileName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function ThreadsSection({
  prNumber,
  model,
  error,
  threads,
}: {
  prNumber: number;
  model: GithubReviewModel | null;
  error: GithubFailure | null;
  threads: RailThreads;
}) {
  if (!model)
    return error ? (
      <p className="gh-rail-empty" role="alert">
        Couldn’t read review threads: <GithubFailureText failure={error} />
      </p>
    ) : (
      <p className="gh-mute gh-rail-empty gh-inline" role="status">
        <Spinner className="h-3 w-3" />
        Reading review threads…
      </p>
    );
  if (model.files.length === 0)
    return (
      <p className="gh-mute gh-rail-empty">
        No review threads on PR #{prNumber}.
      </p>
    );
  return (
    <>
      {error && (
        <p className="gh-rail-empty" role="alert">
          Couldn’t refresh review threads: <GithubFailureText failure={error} />
          . Showing the last read.
        </p>
      )}
      {model.files.map((file) => (
        <section key={file.path} className="gh-rail-file">
          <h4 className="gh-rail-path" title={file.path}>
            {fileName(file.path)}
          </h4>
          <ul>
            {file.threads.map((placed) => {
              const first = placed.thread.comments[0];
              const id = placed.thread.id;
              const expanded = threads.inline.has(id);
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="gh-rail-entry"
                    data-resolved={placed.thread.resolved || undefined}
                    aria-expanded={expanded || undefined}
                    {...{ [REVIEW_ENTRY_ATTRIBUTE]: id }}
                    onClick={() => threads.select(placed)}
                  >
                    <span className="gh-rail-entry-where">
                      {lineLabel(placed)}
                      {placed.thread.resolved && " · resolved"}
                    </span>
                    <span className="gh-rail-entry-text">
                      <span className="gh-login">{authorOf(first)}:</span>{" "}
                      {firstLine(first?.body ?? "")}
                    </span>
                  </button>
                  {expanded && (
                    <div className="gh-rail-card">
                      <GithubThreadCard
                        placed={placed}
                        autoFocus
                        onClose={() => threads.closeInline(id)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {model.truncated && (
        <p className="gh-mute gh-thread-note">
          This PR has more threads than Changes reads; open GitHub for the rest.
        </p>
      )}
    </>
  );
}

/** The linked PR's checks, as the review bar's drawer lists them, denser. */
function ChecksSection({ pr, prNumber }: { pr: WorktreePr; prNumber: number }) {
  const { now } = useChecksFreshness(pr.entry);
  const snapshot = pr.entry.snapshot;
  const headingId = useId();
  return (
    <section className="gh-rail-checks" aria-labelledby={headingId}>
      <h3 id={headingId} className="gh-rail-section">
        Checks
        {snapshot && (
          <>
            <Separator />
            <CheckCounts counts={pr.counts} />
          </>
        )}
      </h3>
      {snapshot ? (
        <PrChecksList
          dense
          prNumber={prNumber}
          checks={pr.checks}
          truncated={snapshot.truncated}
          now={now}
          onRerun={(checkId) => void pr.rerun(checkId)}
          onCancel={(checkId) => void pr.cancel(checkId)}
        />
      ) : pr.entry.read.status === "failed" ? (
        <p className="gh-rail-empty" role="alert">
          Couldn’t read checks:{" "}
          <GithubFailureText failure={pr.entry.read.failure} />
        </p>
      ) : (
        <p className="gh-mute gh-rail-empty gh-inline" role="status">
          <Spinner className="h-3 w-3" />
          Reading checks…
        </p>
      )}
    </section>
  );
}

/**
 * The Review rail: the linked PR's GitHub threads grouped by file in line
 * order, then its checks. Choosing a thread shows it in the diff; a thread
 * the diff cannot show (a file-level comment, a line or file outside this
 * comparison) expands here instead.
 */
export function ReviewRail({
  pr,
  prNumber,
  model,
  loading,
  error,
  threads,
  onClose,
  railRef,
}: {
  pr: WorktreePr;
  prNumber: number | null;
  model: GithubReviewModel | null;
  loading: boolean;
  error: GithubFailure | null;
  threads: RailThreads;
  onClose(): void;
  railRef?: Ref<HTMLElement>;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  let body: ReactNode;
  if (prNumber === null)
    body = (
      <p className="gh-mute gh-rail-empty">
        No linked PR, so there are no GitHub threads to list.
      </p>
    );
  else
    body = (
      <>
        <h3 className="gh-rail-section">
          Threads
          {model && (
            <>
              <Separator />
              {model.openCount} open
            </>
          )}
        </h3>
        <ThreadsSection
          prNumber={prNumber}
          model={model}
          error={error}
          threads={threads}
        />
        <ChecksSection pr={pr} prNumber={prNumber} />
      </>
    );
  return (
    <aside
      ref={railRef}
      tabIndex={-1}
      className="gh-rail"
      aria-label="Review rail"
      data-owns-escape=""
      onKeyDown={onKeyDown}
    >
      <header className="gh-rail-head">
        <GitHubGlyph size="xs" />
        <h2>Review</h2>
        {prNumber !== null && <span className="gh-mute">PR #{prNumber}</span>}
        {loading && model && <Spinner className="h-3 w-3" />}
        <span className="gh-spacer" />
        <button
          type="button"
          className="gh-icon-button"
          aria-label="Close Review rail"
          title="Close Review rail (Esc)"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="gh-rail-body">{body}</div>
    </aside>
  );
}
