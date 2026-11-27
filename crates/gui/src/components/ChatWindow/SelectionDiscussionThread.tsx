/**
 * An inline discussion as it shows in a diff, the Discussions section or a
 * GitHub thread's card: its transcript, composer and turn controls.
 */
import { useContext, useEffect, useRef, useState } from "react";
import { useInlineScrollFollow } from "./useInlineScrollFollow";
import { useUIStore } from "../../stores/uiStore";
import { ThinkingIndicator } from "./ThinkingIndicator";
import {
  getLocalChatLifecycle,
  useChatStore,
  type ActiveChatTurn,
} from "../../stores/chatStore";
import {
  anchorNotice,
  selectionLabel,
  type CodeSelection,
  type DiscussionState,
} from "./selectionDiscussions";
import { ChatTranscript } from "./ChatMessages";
import { collapseTurns, earlierTurnsLabel } from "./discussionTurns";
import {
  DISCUSSION_ASK_SHORTCUT,
  DISCUSSION_COLLAPSE_SHORTCUT,
  DISCUSSION_SEND_SHORTCUT,
  DISCUSSION_OPEN_KEY,
  matchesChatShortcut,
  shortcutText,
} from "./chatShortcuts";
import {
  SelectionDiscussionModelContext,
  SelectionDiscussionContext,
  type DiscussionValue,
} from "./selectionDiscussionState";
import { focusKeepProps } from "../../utils/focusKeep";
import { useKeepFocus } from "../../hooks/useKeepFocus";
import { OWNS_ESCAPE_ATTRIBUTE } from "../../hooks/useGlassPanel";

const collapseKeys = shortcutText(DISCUSSION_COLLAPSE_SHORTCUT);
const askKeys = shortcutText(DISCUSSION_ASK_SHORTCUT);
const sendKeys = shortcutText(DISCUSSION_SEND_SHORTCUT);

/**
 * Rendered in the diff annotation at the thread's anchor, never in a footer.
 * `onClosed` returns focus to the anchor line after the thread closes.
 */
export function InlineSelectionDiscussion({
  threadId,
  onClosed,
}: {
  threadId: string;
  onClosed?(anchor: CodeSelection): void;
}) {
  const discussion = useContext(SelectionDiscussionContext);
  const thread = discussion?.threads.find((thread) => thread.id === threadId);
  if (!thread || !discussion) return null;
  const notice = anchorNotice(thread.status);

  return discussion.activeId === thread.id ? (
    <MiniThread
      key={thread.id}
      thread={thread}
      discussion={discussion}
      onClosed={thread.status.kind === "inline" ? onClosed : undefined}
    />
  ) : (
    <button
      type="button"
      className="selection-mini-marker"
      aria-label="Reopen selection discussion"
      title={`Open discussion (${DISCUSSION_OPEN_KEY.toUpperCase()} on its line)`}
      aria-keyshortcuts={DISCUSSION_OPEN_KEY}
      onClick={() => discussion.reopen(thread.id, { focus: true })}
    >
      Discussion · {selectionLabel(thread.anchor)}
      {notice && ` · ${notice.marker}`}
    </button>
  );
}

/** An open discussion: its transcript, composer and turn controls. */
export function MiniThread({
  thread,
  discussion,
  onClosed,
}: {
  thread: DiscussionState["threads"][number];
  discussion: DiscussionValue;
  onClosed?(anchor: CodeSelection): void;
}) {
  // A closed discussion keeps its unsent question for when it reopens.
  const [question, setQuestionState] = useState(() =>
    discussion.draft(thread.id)
  );
  const setQuestion = (text: string) => {
    setQuestionState(text);
    discussion.setDraft(thread.id, text);
  };
  const github = thread.githubThreadId !== null;
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useKeepFocus(composerRef);
  const thinkingStyle = useUIStore((state) => state.thinkingIndicatorStyle);
  const choice = useContext(SelectionDiscussionModelContext);
  const session = useChatStore((state) =>
    thread.sessionId ? state.sessions[thread.sessionId] : undefined
  );

  const activeTurn = session?.activeTurn ?? null;
  const cardRef = useInlineScrollFollow(activeTurn?.localId);
  const failed = getLocalChatLifecycle(session) === "error";
  const announcement = useTurnAnnouncement(activeTurn, failed);
  const notice = anchorNotice(thread.status);

  // Opening from the keyboard puts the caret in the composer, once. Opening
  // also highlights the anchor, and the diff re-renders its rows a frame
  // later, which can blur the slotted composer; focus again after that.
  const { focusRequest, focusTaken } = discussion;
  useEffect(() => {
    if (focusRequest !== thread.id) return;
    const focus = () => {
      const composer = composerRef.current;
      if (composer && document.activeElement !== composer) composer.focus();
    };
    focus();
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        focus();
        focusTaken(thread.id);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, focusTaken, thread.id]);

  const collapsed = discussion.collapsed.has(thread.id);
  const turns = collapsed && session ? collapseTurns(session.messages) : null;
  const hidden = turns && turns.earlier > 0 ? turns : null;
  const toggleCollapsed = () => discussion.toggleCollapsed(thread.id);
  const close = () => {
    discussion.reopen(null);
    onClosed?.(thread.anchor);
  };
  const unreadable = thread.status.kind === "unreadable";
  const canAsk =
    !unreadable && !activeTurn && !!question.trim() && !choice?.error;
  const ask = () => {
    if (!canAsk) return;
    discussion.send(thread.id, question);
    setQuestion("");
  };
  const sendToMain = () => {
    if (unreadable) return;
    discussion.attachThread(thread.id, question);
    // A GitHub thread's discussion is attached as it stands; its draft stays.
    if (!github) setQuestion("");
  };

  return (
    <section
      ref={cardRef}
      className="selection-mini-thread"
      data-private={github ? "" : undefined}
      aria-label={github ? "Private discussion" : "Selection discussion"}
      data-testid="selection-mini-thread"
      // Esc closes this thread, not the chat workspace around it.
      {...{ [OWNS_ESCAPE_ATTRIBUTE]: "" }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (matchesChatShortcut(event, DISCUSSION_COLLAPSE_SHORTCUT)) {
          event.preventDefault();
          if (!event.repeat) toggleCollapsed();
          return;
        }
        const plain =
          !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
        if (event.key !== "Escape" || !plain) return;
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (
          github ||
          thread.status.kind !== "inline" ||
          event.currentTarget.ownerDocument.getSelection()?.isCollapsed ===
            false ||
          (event.target instanceof Element &&
            event.target.closest("button, a, input, textarea, select, pre"))
        )
          return;
        discussion.select(thread.anchor);
      }}
    >
      <header className="selection-mini-header">
        {github ? (
          <span className="selection-mini-private">
            <LockGlyph />
            <span>Private discussion</span>
          </span>
        ) : (
          <button
            type="button"
            className="selection-mini-anchor"
            disabled={thread.status.kind !== "inline"}
            aria-label={`Highlight selected code: ${selectionLabel(thread.anchor)}`}
            title="Highlight selected code"
            onClick={() => discussion.select(thread.anchor)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-10-2 20" />
            </svg>
            <span>{selectionLabel(thread.anchor)}</span>
          </button>
        )}
        <span className="selection-mini-badge">Read only</span>
        {notice && (
          <span className="selection-mini-outdated" role="status">
            {notice.label}
          </span>
        )}
        <button
          type="button"
          className="selection-mini-close"
          aria-label={
            collapsed ? "Show all turns" : "Show only the latest response"
          }
          aria-pressed={collapsed}
          aria-keyshortcuts="Meta+Shift+E"
          title={`${collapsed ? "Show all turns" : "Show only the latest response"} (${collapseKeys})`}
          onClick={toggleCollapsed}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path
              d={
                collapsed
                  ? "m7 9 5-5 5 5M7 15l5 5 5-5"
                  : "m7 4 5 5 5-5M7 20l5-5 5 5"
              }
            />
          </svg>
        </button>
        <button
          type="button"
          className="selection-mini-close"
          aria-label="Close discussion"
          aria-keyshortcuts="Escape"
          title="Close discussion (Esc)"
          onClick={close}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      </header>
      {thread.status.kind !== "inline" &&
        thread.status.kind !== "unreadable" && (
          <pre aria-label="Original selected code">
            {thread.git.original.code}
          </pre>
        )}
      <DiscussionModelNotice />
      <div className="selection-mini-messages">
        {hidden && (
          <button
            type="button"
            className="selection-mini-earlier"
            title={`Show all turns (${collapseKeys})`}
            onClick={toggleCollapsed}
          >
            <span aria-hidden="true">▸</span>
            {earlierTurnsLabel(hidden.earlier)}
          </button>
        )}
        {session && (
          <ChatTranscript
            sessionId={session.id}
            messages={hidden?.latest ?? session.messages}
            // Discussions show no model labels; the composer owns that choice.
            assistantLabel="Assistant"
            isActive={!!session.backendSessionId}
            streamingAssistant={session.streamingAssistant ?? null}
          />
        )}
      </div>
      {activeTurn && (
        <div className="selection-mini-thinking">
          <ThinkingIndicator
            label={activeTurn.phase === "stopping" ? "Stopping..." : undefined}
            style={thinkingStyle}
          />
        </div>
      )}
      <p
        className="sr-only"
        data-testid="selection-mini-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
      {failed && <p role="alert">Discussion failed.</p>}
      <form
        className="diff-comment-editor selection-mini-composer"
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <textarea
          ref={composerRef}
          {...focusKeepProps}
          aria-label={
            github ? "Ask about this GitHub thread" : "Ask about selected code"
          }
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
          placeholder={
            github && !session?.messages.length
              ? "Ask privately about this thread…"
              : "Ask a follow-up question…"
          }
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
              return;
            event.preventDefault();
            if (event.repeat) return;
            if (event.shiftKey) sendToMain();
            else ask();
          }}
        />
        <div className="diff-comment-editor-actions selection-mini-actions">
          {activeTurn && (
            <button
              type="button"
              disabled={activeTurn.phase === "stopping"}
              onClick={() => discussion.cancel(thread.id)}
            >
              Cancel response
            </button>
          )}
          <button
            type="button"
            disabled={unreadable}
            title={`Send to main chat (${sendKeys})`}
            aria-keyshortcuts="Meta+Shift+Enter"
            onClick={sendToMain}
          >
            Send to main chat
          </button>
          <button
            type="submit"
            data-primary
            disabled={!canAsk}
            title={`Ask (${askKeys})`}
            aria-keyshortcuts="Meta+Enter"
          >
            Ask
          </button>
        </div>
      </form>
    </section>
  );
}

/** Marks what stays in Vertebrae, never posted to GitHub. */
export function LockGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/** Screen-reader status for the end of each turn. */
function useTurnAnnouncement(
  activeTurn: ActiveChatTurn | null,
  failed: boolean
): string {
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef(activeTurn);

  useEffect(() => {
    const ended = previous.current;
    previous.current = activeTurn;

    if (activeTurn) setAnnouncement("");
    else if (ended)
      setAnnouncement(
        failed
          ? "Discussion failed."
          : ended.phase === "stopping"
            ? "Reply cancelled."
            : "Reply complete."
      );
  }, [activeTurn, failed]);

  return announcement;
}

/** Shared by the initial comment dialog and each follow-up composer. */
export function DiscussionModelNotice() {
  const choice = useContext(SelectionDiscussionModelContext);

  if (!choice?.error) return null;

  // "<reason> Open Settings → … to choose …": the reason leads, the path to
  // fix it follows as a quieter second clause.
  const at = choice.error.indexOf("Open Settings");
  const reason = at > 0 ? choice.error.slice(0, at).trim() : choice.error;
  const fix = at > 0 ? choice.error.slice(at) : "";

  return (
    <p role="alert" className="selection-model-notice" data-tone="warn">
      <span className="selection-model-notice-dot" aria-hidden="true" />
      <span className="selection-model-notice-text">
        <span>{reason}</span>
        {fix && <span className="selection-model-notice-fix"> {fix}</span>}
      </span>
    </p>
  );
}
