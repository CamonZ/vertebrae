import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { MarkdownContent } from "../../../shared/MarkdownContent";
import { Badge } from "../../../atoms/Badge";
import { formatRelative } from "../../../../utils/formatRelative";
import {
  isAbsoluteHttpUrl,
  openExternalUrl,
} from "../../../../utils/openExternalUrl";
import { ExternalLinkGlyph, GitHubGlyph } from "../../GithubPr";
import {
  authorOf,
  avatarHue,
  driftExplanation,
  firstLine,
  initialOf,
  lineLabel,
} from "./model";
import type { PlacedThread } from "./model";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { ReviewAnnotation } from "../../../thread/toolChange/DiffCommentThread";
import {
  OUTDATED_TOGGLE_ATTRIBUTE,
  type GithubDiffThreads,
} from "./useReviewController";
import "./githubReview.css";

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
  if (placed.kind === "unplaceable")
    return (
      <div className="gh-anchor-note" data-kind="unplaceable">
        <p>
          {placed.reason === "invalid_anchor"
            ? "GitHub’s anchor for this thread does not fit the file here; open it on GitHub to read it in place."
            : "Changes can’t read this file here (binary, too large, or outside the worktree); open the thread on GitHub to read it in place."}
        </p>
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
  // Resolved threads fold to one line until shown, as on GitHub.
  const [shown, setShown] = useState(!thread.resolved);
  const bodyId = useId();
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
        {thread.resolved && (
          <Badge intent="success" className="gh-badge">
            Resolved
          </Badge>
        )}
        {placed.kind === "outdated" && (
          <Badge intent="neutral" className="gh-badge">
            Outdated
          </Badge>
        )}
        <span className="gh-spacer" />
        {thread.resolved && (
          <button
            type="button"
            className="gh-text-button"
            aria-expanded={shown}
            aria-controls={shown ? bodyId : undefined}
            onClick={() => setShown(!shown)}
          >
            {shown ? "Hide" : "Show"}
          </button>
        )}
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
      {!shown && (
        <p className="gh-thread-folded gh-mute">
          <span className="gh-login">{author}:</span>{" "}
          {firstLine(first?.body ?? "")}
          {thread.comments.length > 1 &&
            ` · ${thread.comments.length - 1} more`}
        </p>
      )}
      {shown && (
        <div id={bodyId}>
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
              Showing the first {thread.comments.length} replies; open GitHub
              for the rest.
            </p>
          )}
        </div>
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
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className="gh-outdated-toggle"
      aria-expanded={open}
      title="GitHub threads on code that changed after they were written"
      {...{ [OUTDATED_TOGGLE_ATTRIBUTE]: path }}
      onClick={onToggle}
    >
      Outdated {count}
    </button>
  );
}

/** The open GitHub threads of one annotation slot: its line's, then the file's outdated. */
export function GithubAnnotationThreads({
  github,
  path,
  lineNumber,
  metadata,
  view,
}: {
  github: GithubDiffThreads;
  path: string;
  lineNumber: number;
  metadata: ReviewAnnotation;
  /** Keeps a closed card's line in view (no jump to where the card was). */
  view: Pick<CodeViewHandle<ReviewAnnotation, undefined>, "scrollTo"> | null;
}) {
  const onClose = (threadId: string) => {
    const placed = github.model.byThread.get(threadId);
    github.closeThread(threadId);
    if (placed?.kind === "line")
      view?.scrollTo({
        type: "line",
        id: placed.thread.anchor.path,
        lineNumber: placed.line,
        side: placed.side,
        align: "nearest",
      });
  };
  const isOpen = ({ thread }: { thread: { id: string } }) =>
    github.openThreads.has(thread.id);
  const line = metadata.githubMarker
    ? (
        github.model.markerByKey.get(metadata.githubMarker)?.threads ?? []
      ).filter(isOpen)
    : [];
  const outdated = metadata.githubOutdated
    ? (github.model.outdatedByPath.get(path) ?? []).filter(isOpen)
    : [];
  return (
    <>
      {line.length > 0 && (
        <GithubThreadGroup
          label={`GitHub threads on line ${lineNumber}`}
          threads={line}
          focusThreadId={github.focusThreadId}
          onFocused={github.focused}
          onClose={onClose}
        />
      )}
      {outdated.length > 0 && (
        <GithubThreadGroup
          label={`Outdated GitHub threads in ${path}`}
          threads={outdated}
          focusThreadId={github.focusThreadId}
          onFocused={github.focused}
          onClose={onClose}
        />
      )}
    </>
  );
}

/** A file heading's Outdated pill, when the file has outdated threads. */
export function GithubOutdatedPill({
  github,
  path,
  onExpand,
}: {
  github: GithubDiffThreads;
  path: string;
  /** The file is folded: unfold it so the threads can show. */
  onExpand(): void;
}) {
  const outdated = github.model.outdatedByPath.get(path) ?? [];
  if (outdated.length === 0) return null;
  return (
    <OutdatedToggle
      path={path}
      count={outdated.length}
      open={outdated.some(({ thread }) => github.openThreads.has(thread.id))}
      onToggle={() => {
        onExpand();
        github.toggleOutdated(path);
      }}
    />
  );
}
