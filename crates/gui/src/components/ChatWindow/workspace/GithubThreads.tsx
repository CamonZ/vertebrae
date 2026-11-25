import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { GithubFailure, GithubReviewComment } from "../../../bindings";
import { MarkdownContent } from "../../shared/MarkdownContent";
import { Badge } from "../../atoms/Badge";
import { Spinner } from "../../Spinner";
import { formatRelative } from "../../../utils/formatRelative";
import {
  isAbsoluteHttpUrl,
  openExternalUrl,
} from "../../../utils/openExternalUrl";
import { ExternalLinkGlyph, GitHubGlyph } from "../GithubPr";
import { GithubFailureText } from "./PrFailure";
import {
  avatarHue,
  driftExplanation,
  initialOf,
  lineLabel,
  type GithubReviewModel,
  type PlacedThread,
} from "./githubReview";
import "./githubReview.css";

/** Marks rail entries so a closed thread can hand focus back to its entry. */
export const REVIEW_ENTRY_ATTRIBUTE = "data-review-entry";
/** Marks a file's Outdated toggle, for the same reason. */
export const OUTDATED_TOGGLE_ATTRIBUTE = "data-gh-outdated-toggle";

function GithubAvatar({ login }: { login: string }) {
  return (
    <span
      className="gh-avatar"
      aria-hidden="true"
      style={{ "--gh-hue": avatarHue(login) } as CSSProperties}
    >
      {initialOf(login)}
    </span>
  );
}

function authorOf(comment: GithubReviewComment | undefined): string {
  return comment?.author?.login ?? "ghost";
}

function Snippet({
  lines,
  label,
}: {
  lines: readonly { number: number; text: string; focus: boolean }[];
  label: string;
}) {
  if (lines.length === 0) return null;
  return (
    <pre className="gh-snippet" aria-label={label}>
      {lines.map((line) => (
        <span
          key={line.number}
          className="gh-snippet-line"
          data-focus={line.focus || undefined}
        >
          <span className="gh-snippet-number" aria-hidden="true">
            {line.number}
          </span>
          {line.text || " "}
        </span>
      ))}
    </pre>
  );
}

/** Why the thread is not plainly on its line, with what reviewers saw. */
function AnchorNote({ placed }: { placed: PlacedThread }) {
  if (placed.kind === "outdated")
    return (
      <div className="gh-anchor-note" data-kind="outdated">
        <p>
          GitHub marks this thread outdated: the commented code changed in a
          later push
          {placed.originalLine ? ` (it was line ${placed.originalLine})` : ""}.
        </p>
        <Snippet lines={placed.original} label="Code as originally commented" />
      </div>
    );
  if (placed.kind === "file")
    return placed.shown ? null : (
      <div className="gh-anchor-note">
        <p>This file is not part of the shown comparison.</p>
      </div>
    );
  const text = driftExplanation(placed);
  if (!text) return null;
  return (
    <div className="gh-anchor-note" data-kind={placed.drift.kind}>
      <p>{text}</p>
      {placed.drift.kind === "edited" && (
        <Snippet lines={placed.published} label="Code as published" />
      )}
    </div>
  );
}

export function GithubThreadCard({
  placed,
  position,
  onClose,
  autoFocus = false,
  onFocused,
}: {
  placed: PlacedThread;
  /** "thread 1 of 2" when several share the line. */
  position?: { index: number; total: number };
  onClose?(): void;
  autoFocus?: boolean;
  onFocused?(): void;
}) {
  const ref = useRef<HTMLElement>(null);
  const { thread } = placed;
  const first = thread.comments[0];
  const url = first?.url;
  const author = authorOf(first);
  useEffect(() => {
    if (!autoFocus || !ref.current) return;
    ref.current.focus({ preventScroll: true });
    onFocused?.();
  }, [autoFocus, onFocused]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !onClose) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className="gh-thread"
      data-resolved={thread.resolved || undefined}
      data-thread-id={thread.id}
      data-owns-escape={onClose ? "" : undefined}
      aria-label={`GitHub thread from ${author}, ${lineLabel(placed)}`}
      onKeyDown={onKeyDown}
    >
      <header className="gh-thread-head">
        <GitHubGlyph size="xs" />
        <span className="gh-thread-where">{lineLabel(placed)}</span>
        {position && position.total > 1 && (
          <span className="gh-mute">
            thread {position.index + 1} of {position.total}
          </span>
        )}
        {thread.resolved && <Badge intent="success">Resolved</Badge>}
        {placed.kind === "outdated" && <Badge intent="neutral">Outdated</Badge>}
        <span className="gh-spacer" />
        {onClose && (
          <button
            type="button"
            className="gh-icon-button"
            aria-label="Close thread"
            title="Close thread (Esc)"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </header>
      <AnchorNote placed={placed} />
      <ol className="gh-comments">
        {thread.comments.map((comment) => {
          const login = authorOf(comment);
          return (
            <li key={comment.id} className="gh-comment">
              <GithubAvatar login={login} />
              <div className="gh-comment-main">
                <div className="gh-comment-meta">
                  <span className="gh-login">{login}</span>
                  {comment.createdAt && (
                    <time
                      dateTime={comment.createdAt}
                      title={comment.createdAt}
                    >
                      {formatRelative(comment.createdAt)}
                    </time>
                  )}
                </div>
                <div className="gh-comment-body">
                  <MarkdownContent text={comment.body} />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {thread.commentsTruncated && (
        <p className="gh-mute gh-thread-note">
          Showing the first {thread.comments.length} replies; open GitHub for
          the rest.
        </p>
      )}
      {url && isAbsoluteHttpUrl(url) && (
        <footer className="gh-thread-foot">
          <button
            type="button"
            className="gh-github-action"
            onClick={() => openExternalUrl(url)}
          >
            <GitHubGlyph size="xs" />
            Open on GitHub
            <ExternalLinkGlyph />
          </button>
        </footer>
      )}
    </section>
  );
}

/** The threads expanded under one line (or a file's outdated threads). */
export function GithubThreadGroup({
  threads,
  onClose,
  focusThreadId,
  onFocused,
  label,
}: {
  threads: readonly PlacedThread[];
  onClose(threadId: string): void;
  focusThreadId?: string | null;
  onFocused?(): void;
  label: string;
}) {
  return (
    <div className="gh-thread-group" role="group" aria-label={label}>
      {threads.map((placed, index) => (
        <GithubThreadCard
          key={placed.thread.id}
          placed={placed}
          position={{ index, total: threads.length }}
          autoFocus={placed.thread.id === focusThreadId}
          onFocused={onFocused}
          onClose={() => onClose(placed.thread.id)}
        />
      ))}
    </div>
  );
}

export function OutdatedToggle({
  path,
  count,
  open,
  onToggle,
}: {
  path: string;
  count: number;
  open: boolean;
  onToggle(opener: HTMLElement): void;
}) {
  return (
    <button
      type="button"
      className="gh-outdated-toggle"
      aria-expanded={open}
      title="GitHub threads on code that changed after they were written"
      {...{ [OUTDATED_TOGGLE_ATTRIBUTE]: path }}
      onClick={(event) => onToggle(event.currentTarget)}
    >
      Outdated {count}
    </button>
  );
}

function fileName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function firstLine(text: string) {
  return text.split("\n").find((line) => line.trim()) ?? "";
}

/**
 * The Review rail: every GitHub thread of the linked PR grouped by file, in
 * line order. Choosing one shows it in the diff; a thread the diff cannot
 * show (a file-level comment, a line or file outside this comparison)
 * expands here instead.
 */
export function ReviewRail({
  prNumber,
  model,
  loading,
  error,
  onClose,
  onSelect,
  railRef,
}: {
  prNumber: number | null;
  model: GithubReviewModel | null;
  loading: boolean;
  error: GithubFailure | null;
  onClose(): void;
  /** Show the thread in the diff; false when the diff cannot show it. */
  onSelect(placed: PlacedThread, opener: HTMLElement): boolean;
  railRef?: Ref<HTMLElement>;
}) {
  const [inline, setInline] = useState<ReadonlySet<string>>(() => new Set());
  const toggleInline = (id: string) =>
    setInline((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
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
  else if (!model)
    body = error ? (
      <p className="gh-rail-empty" role="alert">
        Couldn’t read review threads: <GithubFailureText failure={error} />
      </p>
    ) : (
      <p className="gh-mute gh-rail-empty gh-inline" role="status">
        <Spinner className="h-3 w-3" />
        Reading review threads…
      </p>
    );
  else if (model.files.length === 0)
    body = (
      <p className="gh-mute gh-rail-empty">
        No review threads on PR #{prNumber}.
      </p>
    );
  else
    body = (
      <>
        <h3 className="gh-rail-section">Threads · {model.openCount} open</h3>
        {model.files.map((file) => (
          <section key={file.path} className="gh-rail-file">
            <h4 className="gh-rail-path" title={file.path}>
              {fileName(file.path)}
            </h4>
            <ul>
              {file.threads.map((placed) => {
                const first = placed.thread.comments[0];
                const login = authorOf(first);
                const id = placed.thread.id;
                const expanded = inline.has(id);
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className="gh-rail-entry"
                      data-resolved={placed.thread.resolved || undefined}
                      aria-expanded={expanded || undefined}
                      {...{ [REVIEW_ENTRY_ATTRIBUTE]: id }}
                      onClick={(event) => {
                        if (expanded || !onSelect(placed, event.currentTarget))
                          toggleInline(id);
                      }}
                    >
                      <span className="gh-rail-entry-where">
                        {lineLabel(placed)}
                        {placed.thread.resolved && " · resolved"}
                      </span>
                      <span className="gh-rail-entry-text">
                        <span className="gh-login">{login}:</span>{" "}
                        {firstLine(first?.body ?? "")}
                      </span>
                    </button>
                    {expanded && (
                      <div className="gh-rail-card">
                        <GithubThreadCard
                          placed={placed}
                          autoFocus
                          onClose={() => {
                            toggleInline(id);
                            document
                              .querySelector<HTMLElement>(
                                `[${REVIEW_ENTRY_ATTRIBUTE}="${CSS.escape(id)}"]`
                              )
                              ?.focus();
                          }}
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
            This PR has more threads than Changes reads; open GitHub for the
            rest.
          </p>
        )}
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
