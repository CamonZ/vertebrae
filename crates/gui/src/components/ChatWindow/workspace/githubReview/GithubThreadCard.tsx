import {
  Fragment,
  useContext,
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
import { MiniThread } from "../../SelectionDiscussionThread";
import {
  SelectionDiscussionContext,
  type DiscussionValue,
  type GithubDiscussResult,
} from "../../selectionDiscussionState";
import { canDiscussGithub } from "./githubDiscussion";
import {
  DIFF_COMPOSER_SEND_SHORTCUT,
  GITHUB_THREAD_DISCUSS_KEY,
  shortcutText,
} from "../../chatShortcuts";
import { isEditableShortcutTarget } from "../../../../utils/keyboard";
import { replySlot } from "./threadWrites";
import {
  useGithubWrites,
  useWriteSlot,
  type GithubWritesValue,
} from "./threadWritesContext";
import {
  GithubComposer,
  GithubPostButton,
  WriteFailureAlert,
} from "./GithubWriteControls";
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
  edited = [],
}: {
  lines: readonly { number: number; text: string; focus: boolean }[];
  label: string;
  /** Lines a local edit changed, marked as a diff marks removed lines. */
  edited?: readonly number[];
}) {
  if (lines.length === 0) return null;
  return (
    <pre className="gh-snippet" aria-label={label}>
      {lines.map((line) => (
        <span
          key={line.number}
          className="gh-snippet-line"
          data-focus={line.focus || undefined}
          data-edited={edited.includes(line.number) || undefined}
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
        <Snippet
          lines={placed.published}
          label="Code as published"
          edited={placed.drift.lines}
        />
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
  // Resolved threads fold to one line until shown, as on GitHub; an open
  // one (reopened, say) is always shown.
  const [unfolded, setUnfolded] = useState(false);
  const shown = !thread.resolved || unfolded;
  const bodyId = useId();
  useEffect(() => {
    if (!autoFocus || !ref.current) return;
    ref.current.focus({ preventScroll: true });
    onFocused?.();
  }, [autoFocus, onFocused]);
  const discussion = useContext(SelectionDiscussionContext);
  // Why its private discussion did not start, said on the card that asked.
  const [startError, setStartError] = useState<string | null>(null);
  const discuss = async (discussion: DiscussionValue) => {
    setStartError(null);
    const result = await discussInline(discussion, placed);
    if (result && !result.opened) setStartError(result.error);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // The private discussion's composer keeps its own keys (its Esc closes
    // only the discussion, its ⌘⇧↵ sends with the follow-up).
    if (event.defaultPrevented || isEditableShortcutTarget(event.target))
      return;
    const act = (run: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      run();
    };
    const plain =
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (event.key === "Escape" && plain && onClose) act(onClose);
    else if (event.key === GITHUB_THREAD_DISCUSS_KEY && plain && discussion)
      act(() => void discuss(discussion));
    else if (
      event.key === "Enter" &&
      event.metaKey &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      discussion?.canAttachGithub
    )
      act(() => discussion.attachGithub(placed));
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
            onClick={() => setUnfolded(!shown)}
          >
            {shown ? "Hide" : "Show"}
          </button>
        )}
        {url && isAbsoluteHttpUrl(url) && (
          <button
            type="button"
            className="gh-icon-button gh-open-github"
            aria-label="Open on GitHub"
            title="Open on GitHub"
            onClick={() => openExternalUrl(url)}
          >
            <GitHubGlyph size="xs" />
            <ExternalLinkGlyph />
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
      <GithubThreadDiscussion
        placed={placed}
        onClosed={() => ref.current?.focus({ preventScroll: true })}
      />
      {startError && (
        <p role="alert" className="gh-thread-error">
          Couldn’t start the private discussion: {startError}
        </p>
      )}
      <ThreadReply placed={placed} onEscape={onClose} />
      <ThreadActions placed={placed} closable={!!onClose} onDiscuss={discuss} />
    </section>
  );
}

/**
 * The private discussion of a GitHub thread, when it is open. Closing it
 * gives focus back to its card, so the card's keys go on working.
 */
function GithubThreadDiscussion({
  placed,
  onClosed,
}: {
  placed: PlacedThread;
  onClosed(): void;
}) {
  const discussion = useContext(SelectionDiscussionContext);
  const thread = discussion?.threads.find(
    ({ githubThreadId }) => githubThreadId === placed.thread.id
  );
  if (!discussion || !thread || discussion.activeId !== thread.id) return null;
  return (
    <div className="gh-thread-discussion">
      <MiniThread thread={thread} discussion={discussion} onClosed={onClosed} />
    </div>
  );
}

const sendKeys = shortcutText(DIFF_COMPOSER_SEND_SHORTCUT);

/**
 * Show the thread's private discussion, focused, or start one when the
 * thread has lines to discuss here; the result of a start.
 */
async function discussInline(
  discussion: DiscussionValue,
  placed: PlacedThread
): Promise<GithubDiscussResult | null> {
  const thread = discussion.threads.find(
    ({ githubThreadId }) => githubThreadId === placed.thread.id
  );
  if (thread) discussion.reopen(thread.id, { focus: true, inPlace: true });
  else if (discussion.canAsk && canDiscussGithub(placed))
    return discussion.discussGithub(placed);
  return null;
}

/** Where the thread's public writes go, and how the audience reads it. */
function threadAudience(writes: GithubWritesValue, placed: PlacedThread) {
  return `#${writes.pr.number}, ${lineLabel(placed)} · visible to everyone on the PR${
    writes.viewer ? ` as ${writes.viewer}` : ""
  }`;
}

/**
 * The thread's public reply: its composer while a draft is open (kept when
 * the card closes or the comparison changes), Undo after Discard, and a
 * resolve or reopen that failed.
 */
function ThreadReply({
  placed,
  onEscape,
}: {
  placed: PlacedThread;
  onEscape?(): void;
}) {
  const writes = useGithubWrites();
  const { thread } = placed;
  const key = replySlot(thread.id);
  const slot = useWriteSlot(writes?.store, key);
  if (!writes) return null;
  const url = thread.comments[0]?.url ?? null;
  const port = writes.port();
  const canResolve = !thread.resolved && thread.viewerCanResolve;
  return (
    <div className="gh-thread-reply">
      <GithubComposer
        store={writes.store}
        slotKey={key}
        title="Reply on GitHub"
        audience={threadAudience(writes, placed)}
        textLabel={`Reply to ${authorOf(thread.comments[0])} on GitHub`}
        placeholder="Write a reply…"
        posts={[
          {
            label: "Reply on GitHub",
            plan: { kind: "reply", threadId: thread.id, resolve: false },
          },
          ...(canResolve
            ? [
                {
                  label: "Reply and resolve",
                  plan: { kind: "reply", threadId: thread.id, resolve: true },
                  primary: true,
                } as const,
              ]
            : []),
        ]}
        port={port}
        url={url}
        onEscape={onEscape}
      />
      {slot.draft === null && slot.failure && (
        <WriteFailureAlert
          failure={slot.failure}
          draftKept={false}
          url={url}
          pending={slot.pending !== null}
          onRetry={() => void writes.store.retry(key, port)}
        />
      )}
    </div>
  );
}

/**
 * Reply, Resolve and Reopen, each only where GitHub says the viewer may.
 * Hidden while the reply composer is open: it posts (and resolves) itself.
 */
function GithubThreadButtons({ placed }: { placed: PlacedThread }) {
  const writes = useGithubWrites();
  const { thread } = placed;
  const key = replySlot(thread.id);
  const slot = useWriteSlot(writes?.store, key);
  if (!writes || slot.draft !== null) return null;
  const toggle = thread.resolved
    ? thread.viewerCanUnresolve && ("reopen" as const)
    : thread.viewerCanResolve && ("resolve" as const);
  const pending = slot.pending;
  return (
    <>
      {thread.viewerCanReply && (
        <GithubPostButton
          disabled={pending !== null}
          onClick={() => writes.store.open(key)}
        >
          Reply on GitHub
        </GithubPostButton>
      )}
      {toggle && (
        <GithubPostButton
          pending={pending === toggle}
          disabled={pending !== null}
          title={
            toggle === "resolve"
              ? "Resolve the thread on GitHub"
              : "Reopen the thread on GitHub"
          }
          onClick={() =>
            void writes.store.post(
              key,
              { kind: toggle, threadId: thread.id },
              writes.port()
            )
          }
        >
          {pending === toggle
            ? toggle === "resolve"
              ? "Resolving…"
              : "Reopening…"
            : toggle === "resolve"
              ? "Resolve"
              : "Reopen"}
        </GithubPostButton>
      )}
    </>
  );
}

/**
 * The card's actions, as a selection discussion's composer lays them out:
 * key hints, then the GitHub writes the viewer may make, Send to main chat,
 * then the primary Discuss inline (or Show private discussion). While the
 * discussion is open its composer offers the private actions, so only the
 * GitHub ones stay.
 */
function ThreadActions({
  placed,
  closable,
  onDiscuss,
}: {
  placed: PlacedThread;
  closable: boolean;
  onDiscuss(discussion: DiscussionValue): Promise<void>;
}) {
  const discussion = useContext(SelectionDiscussionContext);
  const writes = useGithubWrites();
  const [starting, setStarting] = useState(false);
  const thread = discussion?.threads.find(
    ({ githubThreadId }) => githubThreadId === placed.thread.id
  );
  const open = !!thread && discussion?.activeId === thread.id;
  const canDiscuss =
    !!discussion &&
    !open &&
    (!!thread || (discussion.canAsk && canDiscussGithub(placed)));
  const canSend = !!discussion?.canAttachGithub && !open;
  const github = placed.thread;
  const canWrite =
    !!writes &&
    (github.viewerCanReply ||
      (github.resolved ? github.viewerCanUnresolve : github.viewerCanResolve));
  if (!canDiscuss && !canSend && !canWrite) return null;
  const discussLabel = thread ? "Show private discussion" : "Discuss inline";
  const hints = [
    canDiscuss && ([GITHUB_THREAD_DISCUSS_KEY, discussLabel] as const),
    canSend && ([sendKeys, "Send to main chat"] as const),
    closable && (["esc", "Close"] as const),
  ].filter((hint) => hint !== false);
  return (
    <footer className="gh-thread-foot diff-comment-editor-actions">
      <span className="diff-comment-editor-hint" aria-hidden="true">
        {hints.map(([keys, label], index) => (
          <Fragment key={label}>
            {index > 0 && " · "}
            <kbd>{keys}</kbd> {label.toLowerCase()}
          </Fragment>
        ))}
      </span>
      <div className="diff-comment-editor-buttons">
        <GithubThreadButtons placed={placed} />
        {canSend && discussion && (
          <button
            type="button"
            title={`Send to main chat (${sendKeys})`}
            aria-keyshortcuts="Meta+Shift+Enter"
            onClick={() => discussion.attachGithub(placed)}
          >
            Send to main chat
          </button>
        )}
        {canDiscuss && discussion && (
          <button
            type="button"
            data-primary
            disabled={starting}
            aria-busy={starting || undefined}
            title={`${discussLabel} (${GITHUB_THREAD_DISCUSS_KEY})`}
            aria-keyshortcuts={GITHUB_THREAD_DISCUSS_KEY}
            onClick={() => {
              setStarting(!thread);
              void onDiscuss(discussion).finally(() => setStarting(false));
            }}
          >
            {discussLabel}
          </button>
        )}
      </div>
    </footer>
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
