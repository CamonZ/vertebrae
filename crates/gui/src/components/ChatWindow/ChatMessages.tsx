import { withFileReferenceReplyIds } from "../../utils/fileReferenceReplyIds";
import { LiveAssistantText } from "./LiveAssistantText";
import { liveAssistantKey } from "../../stores/liveAssistantMessages";
import { ChatSessionContext } from "../thread/toolChange/ChatSessionContext";
import { preloadDiffRenderer } from "../thread/toolChange/useWorktreeDelta";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { commands, type LocalChatGateBinding } from "../../bindings";
import type {
  ChatCompactionSummary,
  ChatMessage,
  StreamingAssistantMessage,
} from "../../stores/chatStore";
import { EventLog, Thread } from "../thread";
import type { ThreadModel } from "../thread";
import { chatMessagesToThread } from "./chatMessagesToThread";
import { PermissionRequestTurn } from "./PermissionRequestTurn";
import { UserQuestionTurn } from "./UserQuestionTurn";
import { useChatStore } from "../../stores/chatStore";
import { useUIStore } from "../../stores/uiStore";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { VtbEntityCopyProvider } from "../shared/VtbEntityLink";
import { MarkdownProjectRootProvider } from "../shared/MarkdownContent";
import {
  CHAT_HELP_SHORTCUT,
  presentChatShortcut,
  type ChatShortcutDefinition,
} from "./chatShortcuts";
import {
  textSelectionToAnchor,
  type PendingTextComment,
  type TextSelectionAnchor,
} from "./assistantTextComments";
import type { DiffReviewFocus } from "../thread/toolChange/DiffReviewContext";
import { useCommentHighlights } from "./commentHighlight";
import { CommentShortcutHint } from "./CommentShortcutHint";
import { useScrollFollow } from "./useScrollFollow";
import { hasInlineScrollFollow } from "./useInlineScrollFollow";
import "./chatComments.css";

const LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT = "local-chat-scroll-to-spawn";
const HISTORY_LOAD_THRESHOLD_PX = 240;
const COMMENT_EDITOR_MAX_WIDTH_PX = 384;
const COMMENT_EDITOR_HEIGHT_PX = 230;
const COMMENT_TRIGGER_WIDTH_PX = 96;
const COMMENT_TRIGGER_HEIGHT_PX = 28;
const VIEWPORT_GUTTER_PX = 8;

interface SelectionAction {
  anchor: TextSelectionAnchor;
  /** The live selected range; it follows the transcript as it scrolls. */
  range: Range;
  /** The selection was made from its end towards its start. */
  backward: boolean;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

/** The line box where the selection ended, which is where the pointer is. */
function selectionEdge(action: SelectionAction): DOMRect | null {
  const range = action.range;
  const rects =
    typeof range.getClientRects === "function"
      ? [...range.getClientRects()].filter((rect) => rect.width || rect.height)
      : [];
  if (rects.length) return action.backward ? rects[0] : rects[rects.length - 1];
  return typeof range.getBoundingClientRect === "function"
    ? range.getBoundingClientRect()
    : null;
}

/**
 * The Comment pill sits just past where the selection ended: below its last
 * line when dragged forward, above its first line when dragged backward, so
 * it never covers the text the user selected.
 */
function triggerPosition(action: SelectionAction) {
  const edge = selectionEdge(action) ?? new DOMRect();
  const top = action.backward
    ? edge.top - COMMENT_TRIGGER_HEIGHT_PX - 6
    : edge.bottom + 6;
  const left = action.backward
    ? edge.left
    : edge.right - COMMENT_TRIGGER_WIDTH_PX / 2;
  return {
    top: clamp(top, VIEWPORT_GUTTER_PX, window.innerHeight - 40),
    left: clamp(
      left,
      VIEWPORT_GUTTER_PX,
      window.innerWidth - COMMENT_TRIGGER_WIDTH_PX - VIEWPORT_GUTTER_PX
    ),
  };
}

function editorPosition(action: SelectionAction) {
  const edge = selectionEdge(action) ?? new DOMRect();
  return {
    top: clamp(
      edge.bottom + 6,
      VIEWPORT_GUTTER_PX,
      window.innerHeight - COMMENT_EDITOR_HEIGHT_PX
    ),
    left: clamp(
      edge.left,
      VIEWPORT_GUTTER_PX,
      window.innerWidth - COMMENT_EDITOR_MAX_WIDTH_PX - VIEWPORT_GUTTER_PX
    ),
  };
}

function isBackward(selection: Selection): boolean {
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return false;
  if (anchorNode === focusNode)
    return selection.focusOffset < selection.anchorOffset;
  return !!(
    anchorNode.compareDocumentPosition(focusNode) &
    Node.DOCUMENT_POSITION_PRECEDING
  );
}

const NO_TEXT_COMMENTS: readonly PendingTextComment[] = [];

interface ChatEmptyStateProps {
  notice?: ReactNode;
  chatHelpShortcut?: ChatShortcutDefinition | null;
}

export function ChatEmptyState({
  notice,
  chatHelpShortcut = CHAT_HELP_SHORTCUT,
}: ChatEmptyStateProps) {
  const shortcut = presentChatShortcut(chatHelpShortcut);

  return (
    <div
      className="flex h-full flex-col items-center justify-center text-center"
      data-testid="chat-empty-state"
    >
      <div
        className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-fg)]/8"
        data-chat-icon-tone="grayscale"
        data-testid="chat-empty-state-icon"
      >
        <svg
          className="h-6 w-6 text-[var(--color-fg-mute)]"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 3.582-8 9-8s9 3.582 9 8z"
          />
        </svg>
      </div>
      {notice ?? (
        <>
          <p className="text-sm text-[var(--color-fg-soft)]">
            Create, edit, and delete tasks, steps, and workflows
          </p>
          <p className="mt-1 text-xs text-[var(--color-fg-mute)]">
            Or run a task through a workflow
          </p>
          {shortcut ? (
            <p
              className="mt-3 text-xs text-[var(--color-fg-mute)]"
              data-testid="chat-help-shortcut-hint"
              aria-label={`Press ${shortcut.ariaLabel} to show keyboard shortcuts`}
            >
              Press{" "}
              {shortcut.keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}{" "}
              for chat help
            </p>
          ) : (
            <p
              className="mt-3 text-xs text-[var(--color-fg-mute)]"
              data-testid="chat-help-shortcut-fallback"
            >
              Use the chat panel&apos;s keyboard shortcuts for help
            </p>
          )}
        </>
      )}
    </div>
  );
}

type ChatRenderItem =
  | { kind: "thread"; key: string; thread: ThreadModel }
  | {
      kind: "permission";
      key: string;
      message: Extract<ChatMessage, { kind: "permission_request" }>;
    }
  | {
      kind: "user_question";
      key: string;
      message: Extract<ChatMessage, { kind: "user_question" }>;
    };

function buildChatRenderItems(
  sessionId: string,
  messages: readonly ChatMessage[],
  assistantLabel: string,
  gate: LocalChatGateBinding | null | undefined,
  expandedToolIds: ReadonlySet<string>,
  onToggleTool: (toolId: string) => void
): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  let segment: ChatMessage[] = [];
  let segmentSeq = 0;

  const flushSegment = () => {
    if (segment.length === 0) return;

    const thread = chatMessagesToThread(segment, {
      assistantLabel,
      gate: gate ?? null,
      expanded: expandedToolIds,
      onToggleTool,
    });

    const liveSlots = new Map<
      string,
      Extract<ChatMessage, { kind: "assistant" }>[]
    >();

    for (const message of segment) {
      if (
        message.kind !== "assistant" ||
        !message.itemId ||
        message.parentToolUseId ||
        (message.lifecycle ??
          (message.isPartial ? "streaming" : "completed")) !== "streaming"
      )
        continue;

      const slots = liveSlots.get(message.itemId) ?? [];
      slots.push(message);
      liveSlots.set(message.itemId, slots);
    }

    for (const turn of thread.turns)
      for (const row of turn.messages) {
        if (
          row.type !== "agent" ||
          !row.itemId ||
          (row.lifecycle ?? (row.streaming ? "streaming" : "completed")) !==
            "streaming"
        )
          continue;

        const slot = liveSlots.get(row.itemId)?.shift();
        if (slot)
          row.prose = (
            <LiveAssistantText
              sessionId={sessionId}
              liveKey={liveAssistantKey(slot)}
              fallback={slot.text}
            />
          );
      }

    items.push({
      kind: "thread",
      key: `thread-${segmentSeq++}`,
      thread,
    });

    segment = [];
  };

  withFileReferenceReplyIds(messages).forEach((message, index) => {
    if (message.kind === "permission_request") {
      flushSegment();
      items.push({
        kind: "permission",
        key: message.requestId ?? `permission-${index}`,
        message,
      });
      return;
    }
    if (message.kind === "user_question") {
      flushSegment();
      items.push({
        kind: "user_question",
        key: message.requestId,
        message,
      });
      return;
    }

    segment.push(message);
  });

  flushSegment();
  return items;
}

interface HistoricalChatItemsProps {
  items: readonly ChatRenderItem[];
  sessionId: string;
  isActive: boolean;
  registerRef?: (id: string, element: HTMLElement | null) => void;
  resolveUserQuestion: (sessionId: string, requestId: string) => void;
  markUserQuestionUnavailable: (sessionId: string, requestId: string) => void;
}

const HistoricalChatItems = memo(function HistoricalChatItems({
  items,
  sessionId,
  isActive,
  registerRef,
  resolveUserQuestion,
  markUserQuestionUnavailable,
}: HistoricalChatItemsProps) {
  return items.map((item) =>
    item.kind === "thread" ? (
      <ChatSessionContext.Provider key={item.key} value={sessionId}>
        <EventLog mode="bare">
          <Thread
            thread={item.thread}
            depth={0}
            mode="bare"
            reveal="shallow"
            showHead={false}
            interactive
            registerRef={registerRef}
          />
        </EventLog>
      </ChatSessionContext.Provider>
    ) : item.kind === "permission" ? (
      <PermissionRequestTurn key={item.key} message={item.message} />
    ) : (
      <UserQuestionTurn
        key={item.key}
        message={item.message}
        sessionAvailable={isActive}
        onResolved={(requestId) => resolveUserQuestion(sessionId, requestId)}
        onUnavailable={(requestId) =>
          markUserQuestionUnavailable(sessionId, requestId)
        }
      />
    )
  );
});

/**
 * A session's transcript rows: settled history, live assistant text and the
 * streaming tail. Shared by the chat panel and inline selection discussions.
 */
export function ChatTranscript({
  sessionId,
  messages,
  assistantLabel,
  gate,
  isActive,
  streamingAssistant,
  registerRef,
}: {
  sessionId: string;
  messages: readonly ChatMessage[];
  assistantLabel: string;
  gate?: LocalChatGateBinding | null;
  isActive: boolean;
  streamingAssistant: StreamingAssistantMessage | null;
  registerRef?: (id: string, element: HTMLElement | null) => void;
}) {
  const resolveUserQuestion = useChatStore(
    (state) => state.resolveUserQuestion
  );
  const markUserQuestionUnavailable = useChatStore(
    (state) => state.markUserQuestionUnavailable
  );
  // This state lives above individual rows so future virtualization can
  // unmount/remount them without discarding the user's expansion choices.
  const [expandedToolIds, setExpandedToolIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const toggleTool = useCallback((toolId: string) => {
    setExpandedToolIds((current) => {
      const next = new Set(current);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  }, []);
  const renderItems = useMemo(
    () =>
      buildChatRenderItems(
        sessionId,
        messages,
        assistantLabel,
        gate,
        expandedToolIds,
        toggleTool
      ),
    [sessionId, assistantLabel, gate, expandedToolIds, messages, toggleTool]
  );
  const streamingTail = useMemo(() => {
    if (!streamingAssistant) return null;
    const last = messages[messages.length - 1];
    if (
      last?.kind === "assistant" &&
      last.isPartial &&
      !last.parentToolUseId &&
      last.text === streamingAssistant.text
    ) {
      return null;
    }
    return chatMessagesToThread(
      [
        {
          kind: "assistant" as const,
          text: streamingAssistant.text,
          timestamp: streamingAssistant.timestamp,
          isPartial: true,
          lifecycle: "streaming",
          ...(streamingAssistant.itemId
            ? { itemId: streamingAssistant.itemId }
            : {}),
        },
      ],
      { assistantLabel }
    );
  }, [assistantLabel, messages, streamingAssistant]);

  return (
    <>
      <HistoricalChatItems
        items={renderItems}
        sessionId={sessionId}
        isActive={isActive}
        registerRef={registerRef}
        resolveUserQuestion={resolveUserQuestion}
        markUserQuestionUnavailable={markUserQuestionUnavailable}
      />
      {streamingTail && (
        <div data-testid="chat-streaming-tail">
          <ChatSessionContext.Provider value={sessionId}>
            <EventLog mode="bare">
              <Thread
                thread={streamingTail}
                depth={0}
                mode="bare"
                reveal="shallow"
                showHead={false}
                interactive
              />
            </EventLog>
          </ChatSessionContext.Provider>
        </div>
      )}
    </>
  );
}

interface ChatMessagesProps {
  sessionId: string;
  projectPath?: string | null;
  messages: readonly ChatMessage[];
  assistantLabel: string;
  gate?: LocalChatGateBinding | null;
  isEmpty: boolean;
  isActive: boolean;
  isVisible?: boolean;
  notice?: ReactNode;
  isWaiting: boolean;
  activityLabel?: string | null;
  compactionSummary?: ChatCompactionSummary | null;
  streamingAssistant: StreamingAssistantMessage | null;
  isLoadingInitialHistory?: boolean;
  hasOlderMessages?: boolean;
  isLoadingOlderMessages?: boolean;
  replayError?: string | null;
  onLoadOlderMessages?: () => Promise<boolean>;
  onAddComment?: (anchor: TextSelectionAnchor, body: string) => void;
  /** Pending text comments, highlighted in the transcript. */
  textComments?: readonly PendingTextComment[];
  /** The comment whose composer chip is hovered or pinned. */
  activeCommentId?: string | null;
  /** A request to scroll a comment's quote into view. */
  commentFocus?: DiffReviewFocus | null;
  /** Rendered inline after the last message, such as gate steering. */
  footer?: ReactNode;
}

export function ChatMessages({
  sessionId,
  projectPath,
  messages,
  assistantLabel,
  gate,
  isEmpty,
  isActive,
  isVisible = true,
  notice,
  isWaiting,
  activityLabel,
  compactionSummary,
  streamingAssistant,
  isLoadingInitialHistory = false,
  hasOlderMessages = false,
  isLoadingOlderMessages = false,
  replayError = null,
  onLoadOlderMessages,
  onAddComment = () => undefined,
  textComments = NO_TEXT_COMMENTS,
  activeCommentId = null,
  commentFocus = null,
  footer = null,
}: ChatMessagesProps) {
  const retryHistory = useChatStore(
    (state) => state.refreshProviderThreadSession
  );
  const thinkingIndicatorStyle = useUIStore(
    (state) => state.thinkingIndicatorStyle
  );
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const loadingOlderRef = useRef(isLoadingOlderMessages);
  loadingOlderRef.current = isLoadingOlderMessages;

  const latestMessagesRef = useRef(messages);
  latestMessagesRef.current = messages;
  const prependAnchorRef = useRef<{
    messages: readonly ChatMessage[];
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const blockBottomFollow = useCallback(
    (viewport: HTMLElement) =>
      !!prependAnchorRef.current || hasInlineScrollFollow(viewport),
    []
  );
  const {
    schedule: scheduleBottomFollow,
    reset: resetBottomFollow,
    following: keepAtBottomRef,
    lastTop: lastScrollTopRef,
    beginUserScroll,
    beginGesture,
    onKeyDown: onScrollKeyDown,
    onScroll: trackScroll,
  } = useScrollFollow(messagesContainerRef, isVisible, {
    blocked: blockBottomFollow,
  });
  const [projectRoots, setProjectRoots] = useState<readonly string[]>(
    projectPath ? [projectPath] : []
  );
  const [selectionAction, setSelectionAction] =
    useState<SelectionAction | null>(null);
  const [commentEditorOpen, setCommentEditorOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  // Re-render on transcript scroll so the pill and editor follow the text.
  const [, setLayoutTick] = useState(0);
  // The pill waits until a pointer selection is finished; shown mid-drag it
  // would sit under the pointer and get in the way of the selection.
  const pointerSelectingRef = useRef(false);
  const updateTextSelection = useCallback(() => {
    if (commentEditorOpen || pointerSelectingRef.current) {
      return;
    }
    const transcript = messagesContainerRef.current;
    const selection = window.getSelection();
    if (!transcript || !selection || selection.isCollapsed) {
      setSelectionAction(null);
      return;
    }

    const anchor = textSelectionToAnchor(selection, transcript);
    if (!anchor) {
      setSelectionAction(null);
      return;
    }

    setSelectionAction({
      anchor,
      range: selection.getRangeAt(0).cloneRange(),
      backward: isBackward(selection),
    });
  }, [commentEditorOpen]);
  useEffect(() => {
    const begin = (event: PointerEvent) => {
      if (
        event.button > 0 ||
        !(event.target instanceof Node) ||
        !messagesContainerRef.current?.contains(event.target)
      )
        return;
      pointerSelectingRef.current = true;
      if (!commentEditorOpen) setSelectionAction(null);
    };
    const end = () => {
      if (!pointerSelectingRef.current) return;
      pointerSelectingRef.current = false;
      // Double and triple clicks extend the selection after pointerup.
      setTimeout(updateTextSelection, 0);
    };
    document.addEventListener("pointerdown", begin, true);
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
    return () => {
      document.removeEventListener("pointerdown", begin, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
    };
  }, [updateTextSelection, commentEditorOpen]);
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!selectionAction || !container) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setLayoutTick((tick) => tick + 1));
    };
    container.addEventListener("scroll", follow, { passive: true });
    window.addEventListener("resize", follow);
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener("scroll", follow);
      window.removeEventListener("resize", follow);
    };
  }, [selectionAction]);
  useCommentHighlights(
    messagesContainerRef,
    textComments,
    activeCommentId,
    commentFocus,
    [messages, streamingAssistant]
  );
  // Tool calls with file changes render as diffs; warm Pierre ahead of them.
  useEffect(preloadDiffRenderer, []);
  useEffect(() => {
    document.addEventListener("selectionchange", updateTextSelection);
    return () =>
      document.removeEventListener("selectionchange", updateTextSelection);
  }, [updateTextSelection]);
  useEffect(() => {
    setSelectionAction(null);
    setCommentEditorOpen(false);
    setCommentDraft("");
    window.getSelection()?.removeAllRanges();
  }, [sessionId]);
  const submitCommentDraft = useCallback(() => {
    const body = commentDraft.trim();
    if (!selectionAction || !body) return;

    onAddComment(selectionAction.anchor, body);
    setCommentDraft("");
    setCommentEditorOpen(false);
    setSelectionAction(null);
    window.getSelection()?.removeAllRanges();
  }, [commentDraft, onAddComment, selectionAction]);
  const registerMessageRef = useCallback(
    (id: string, element: HTMLElement | null) => {
      if (element) {
        messageRefs.current.set(id, element);
      } else {
        messageRefs.current.delete(id);
      }
    },
    []
  );
  const handleLoadOlderMessages = useCallback(
    (retry = false) => {
      const container = messagesContainerRef.current;
      if (
        !container ||
        !onLoadOlderMessages ||
        !hasOlderMessages ||
        isLoadingOlderMessages ||
        isLoadingInitialHistory ||
        (replayError && !retry) ||
        prependAnchorRef.current ||
        !isVisible
      ) {
        return;
      }
      const anchor = {
        messages,
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
      prependAnchorRef.current = anchor;
      keepAtBottomRef.current = false;

      void onLoadOlderMessages().then(
        (applied) => {
          if (prependAnchorRef.current !== anchor) return;

          if (!applied) {
            prependAnchorRef.current = null;
            return;
          }

          requestAnimationFrame(() => {
            if (prependAnchorRef.current !== anchor) return;

            if (anchor.messages === latestMessagesRef.current) {
              prependAnchorRef.current = null;
            }
          });
        },
        () => {
          if (prependAnchorRef.current === anchor)
            prependAnchorRef.current = null;
        }
      );
    },
    [
      hasOlderMessages,
      isLoadingOlderMessages,
      isLoadingInitialHistory,
      replayError,
      isVisible,
      messages,
      onLoadOlderMessages,
      keepAtBottomRef,
    ]
  );

  useEffect(() => {
    let cancelled = false;
    setProjectRoots(projectPath ? [projectPath] : []);
    if (!projectPath) return () => undefined;

    void commands
      .getLocalFileRoots(projectPath)
      .then((result) => {
        if (!cancelled && result.status === "ok") {
          setProjectRoots(result.data);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Could not resolve local chat worktree roots:", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useLayoutEffect(() => {
    resetBottomFollow();
    prependAnchorRef.current = null;

    return () => {
      prependAnchorRef.current = null;
    };
  }, [sessionId, resetBottomFollow]);

  // Keep streaming updates inside this scroll container. Calling
  // scrollIntoView on every delta also scrolls ancestor containers and queues
  // a smooth animation for every line, which makes the entire chat panel jump
  // upward while the provider is responding.
  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const anchor = prependAnchorRef.current;
    if (anchor && anchor.messages !== messages) {
      if (isLoadingOlderMessages) {
        // Live messages may arrive while the page request is in flight. Move
        // the baseline forward without consuming the prepend anchor so only
        // the eventual height inserted above the viewport is compensated.
        anchor.messages = messages;
        anchor.scrollHeight = container.scrollHeight;
        anchor.scrollTop = container.scrollTop;
        return;
      }
      container.scrollTop =
        anchor.scrollTop + (container.scrollHeight - anchor.scrollHeight);
      lastScrollTopRef.current = container.scrollTop;
      prependAnchorRef.current = null;
      return;
    }
    scheduleBottomFollow();
  }, [
    isLoadingOlderMessages,
    isWaiting,
    messages,
    streamingAssistant,
    scheduleBottomFollow,
    lastScrollTopRef,
  ]);

  // Live text subscribers and lazy diffs can resize without rebuilding history.
  useEffect(() => {
    if (!isVisible) return;

    const content = contentRef.current;
    const container = messagesContainerRef.current;
    let disposed = false;

    const resized = () => {
      if (disposed) return;

      const anchor = prependAnchorRef.current;
      const container = messagesContainerRef.current;

      if (anchor && container && loadingOlderRef.current) {
        anchor.scrollHeight = container.scrollHeight;
        anchor.scrollTop = container.scrollTop;
      }

      scheduleBottomFollow();
    };

    const observer =
      typeof ResizeObserver !== "undefined" && content
        ? new ResizeObserver(resized)
        : null;

    if (content) observer?.observe(content);
    if (container) observer?.observe(container);

    scheduleBottomFollow();

    return () => {
      disposed = true;

      observer?.disconnect();
    };
  }, [sessionId, isVisible, scheduleBottomFollow]);

  useEffect(() => {
    const handleScrollToSpawn = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          sessionId?: string;
          spawnId?: string;
        }>
      ).detail;
      if (detail?.sessionId !== sessionId || !detail.spawnId) return;

      const target = messageRefs.current.get(detail.spawnId);
      if (!target) return;

      beginUserScroll();
      keepAtBottomRef.current = false;

      target.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    window.addEventListener(
      LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT,
      handleScrollToSpawn
    );
    return () =>
      window.removeEventListener(
        LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT,
        handleScrollToSpawn
      );
  }, [sessionId, beginUserScroll, keepAtBottomRef]);

  return (
    <VtbEntityCopyProvider>
      <MarkdownProjectRootProvider
        projectPath={projectPath}
        projectRoots={projectRoots}
      >
        <div
          ref={messagesContainerRef}
          className="min-h-0 flex-1 overflow-y-auto p-4"
          data-testid="chat-messages-scroll"
          data-transcript-viewport
          onWheel={(event) => {
            if (event.deltaY < 0) {
              beginUserScroll();
              if (event.currentTarget.scrollTop <= HISTORY_LOAD_THRESHOLD_PX)
                handleLoadOlderMessages();
            }
          }}
          onTouchStart={beginGesture}
          onPointerDown={(event) => {
            // Scrollbar drags target the scroller; clicks in messages do not.
            if (event.target === event.currentTarget) beginGesture();
          }}
          onKeyDown={(event) => onScrollKeyDown(event.nativeEvent)}
          onMouseUp={updateTextSelection}
          onKeyUp={updateTextSelection}
          onScroll={(event) => {
            const container = event.currentTarget;
            if (hasInlineScrollFollow(container)) {
              // An inline turn owns this viewport while it streams. Its scroll
              // writes must not load main-chat history or trigger an end jump.
              keepAtBottomRef.current = false;
              lastScrollTopRef.current = container.scrollTop;
              return;
            }
            const { top, movedUp } = trackScroll(container);
            if (top <= HISTORY_LOAD_THRESHOLD_PX && movedUp)
              handleLoadOlderMessages();

            const anchor = prependAnchorRef.current;
            if (anchor) {
              anchor.scrollHeight = container.scrollHeight;
              anchor.scrollTop = container.scrollTop;
            }
          }}
        >
          {isEmpty && !isActive && !isLoadingInitialHistory && (
            <ChatEmptyState notice={notice} />
          )}
          <div ref={contentRef} className="min-w-0 flex flex-col gap-3">
            {isLoadingInitialHistory && (
              <div
                className="text-center text-xs text-[var(--color-fg-mute)]"
                role="status"
              >
                Loading conversation history…
              </div>
            )}
            {isLoadingOlderMessages && (
              <div
                className="text-center text-xs text-[var(--color-fg-mute)]"
                role="status"
              >
                Loading older messages…
              </div>
            )}
            {replayError && (
              <div
                className="text-center text-xs text-[var(--color-warn)]"
                role="status"
              >
                {replayError}
                <button
                  type="button"
                  onClick={() => {
                    if (hasOlderMessages && onLoadOlderMessages)
                      handleLoadOlderMessages(true);
                    else retryHistory(sessionId);
                  }}
                >
                  Retry history
                </button>
              </div>
            )}
            <ChatTranscript
              sessionId={sessionId}
              messages={messages}
              assistantLabel={assistantLabel}
              gate={gate}
              isActive={isActive}
              streamingAssistant={streamingAssistant}
              registerRef={registerMessageRef}
            />
            {isWaiting && (
              <ThinkingIndicator
                label={activityLabel ?? undefined}
                style={thinkingIndicatorStyle}
              />
            )}
            {!isWaiting && compactionSummary && (
              <div
                className="flex justify-start"
                data-testid="chat-compaction-summary"
                role="status"
                aria-live="polite"
              >
                <span className="text-xs text-[var(--color-fg-mute)]">
                  Conversation compacted
                  {compactionSummary.trigger
                    ? ` (${compactionSummary.trigger})`
                    : ""}
                  {compactionSummary.preTokens !== null
                    ? ` · ${compactionSummary.preTokens.toLocaleString()} tokens before compaction`
                    : ""}
                </span>
              </div>
            )}
            {footer}
          </div>
          {selectionAction && !commentEditorOpen
            ? createPortal(
                <button
                  type="button"
                  className="chat-comment-trigger"
                  data-testid="local-chat-add-comment"
                  aria-label="Add comment"
                  title="Comment on the selected text"
                  style={triggerPosition(selectionAction)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setCommentDraft("");
                    setCommentEditorOpen(true);
                  }}
                >
                  <svg
                    aria-hidden="true"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    viewBox="0 0 24 24"
                  >
                    <path d="M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5 8.6 8.6 0 0 1-4-.95L3 20l.95-4.55A8.5 8.5 0 1 1 20.5 11.5Z" />
                    <path d="M12 8.5v6M9 11.5h6" />
                  </svg>
                  Comment
                </button>,
                document.body
              )
            : null}
          {selectionAction && commentEditorOpen
            ? createPortal(
                <div
                  className="chat-comment-card chat-comment-card-fixed"
                  data-owns-escape=""
                  role="group"
                  aria-label="Add a comment to selected text"
                  style={editorPosition(selectionAction)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    setCommentEditorOpen(false);
                  }}
                >
                  <div className="chat-comment-card-header">
                    <span className="chat-comment-card-title">
                      Comment on selection
                    </span>
                  </div>
                  <blockquote className="chat-comment-quote">
                    <mark>{selectionAction.anchor.quote.trim()}</mark>
                  </blockquote>
                  <label htmlFor="local-chat-comment-draft" className="sr-only">
                    Comment on selected text
                  </label>
                  <textarea
                    id="local-chat-comment-draft"
                    data-testid="local-chat-comment-draft"
                    aria-label="Comment on selected text"
                    className="chat-comment-textarea"
                    placeholder="Add your comment…"
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key !== "Enter" ||
                        !(event.metaKey || event.ctrlKey)
                      )
                        return;
                      event.preventDefault();
                      submitCommentDraft();
                    }}
                    autoFocus
                    rows={3}
                  />
                  <div className="chat-comment-card-footer">
                    <CommentShortcutHint action="add" />
                    <button
                      type="button"
                      className="chat-comment-button"
                      onClick={() => setCommentEditorOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      data-testid="local-chat-save-comment"
                      className="chat-comment-button"
                      data-primary=""
                      disabled={!commentDraft.trim()}
                      onClick={submitCommentDraft}
                    >
                      Add to reply
                    </button>
                  </div>
                </div>,
                document.body
              )
            : null}
        </div>
      </MarkdownProjectRootProvider>
    </VtbEntityCopyProvider>
  );
}
