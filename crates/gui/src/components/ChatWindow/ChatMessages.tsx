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
  type TextSelectionAnchor,
} from "./assistantTextComments";

const LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT = "local-chat-scroll-to-spawn";
const BOTTOM_SCROLL_TOLERANCE_PX = 24;
// Stay inside WebKit's signed scrolling range; MAX_SAFE_INTEGER wraps to zero.
const BOTTOM_SCROLL_TARGET_PX = 1_000_000_000;
const COMMENT_EDITOR_MAX_WIDTH_PX = 384;
const COMMENT_EDITOR_VIEWPORT_GUTTER_PX = 8;

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
  onToggleTool: (toolId: string) => void,
  fullContentToolIds: ReadonlySet<string>,
  onToggleFullContent: (toolId: string) => void
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
      fullContent: fullContentToolIds,
      onToggleFullContent,
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

  messages.forEach((message, index) => {
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
  const [fullContentToolIds, setFullContentToolIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const toggleTool = useCallback((toolId: string) => {
    setExpandedToolIds((current) => {
      const next = new Set(current);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  }, []);
  const toggleFullContent = useCallback((toolId: string) => {
    setFullContentToolIds((current) => {
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
        toggleTool,
        fullContentToolIds,
        toggleFullContent
      ),
    [
      sessionId,
      assistantLabel,
      gate,
      expandedToolIds,
      fullContentToolIds,
      messages,
      toggleFullContent,
      toggleTool,
    ]
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

  const visibleRef = useRef(isVisible);
  visibleRef.current = isVisible;

  const loadingOlderRef = useRef(isLoadingOlderMessages);
  loadingOlderRef.current = isLoadingOlderMessages;

  const bottomFollowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const scheduleBottomFollow = useCallback(() => {
    if (
      !visibleRef.current ||
      document.hidden ||
      bottomFollowTimerRef.current !== null
    )
      return;

    bottomFollowTimerRef.current = setTimeout(() => {
      bottomFollowTimerRef.current = null;

      const container = messagesContainerRef.current;
      if (
        !container ||
        !visibleRef.current ||
        document.hidden ||
        !keepAtBottomRef.current ||
        activeScrollGestureRef.current ||
        prependAnchorRef.current
      )
        return;

      // The browser clamps this write. Do not force a full-transcript height read.
      container.scrollTop = BOTTOM_SCROLL_TARGET_PX;
      lastScrollTopRef.current = container.scrollTop;

      if (!activeScrollGestureRef.current) userScrollRef.current = false;
    }, 32);
  }, []);

  const latestMessagesRef = useRef(messages);
  latestMessagesRef.current = messages;
  const prependAnchorRef = useRef<{
    messages: readonly ChatMessage[];
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const keepAtBottomRef = useRef(true);
  const lastScrollTopRef = useRef<number | null>(null);
  const userScrollRef = useRef(false);
  const activeScrollGestureRef = useRef(false);

  const beginUserScroll = useCallback(() => {
    userScrollRef.current = true;

    if (bottomFollowTimerRef.current !== null)
      clearTimeout(bottomFollowTimerRef.current);
    bottomFollowTimerRef.current = null;
  }, []);
  const [projectRoots, setProjectRoots] = useState<readonly string[]>(
    projectPath ? [projectPath] : []
  );
  const [selectionAction, setSelectionAction] = useState<{
    anchor: TextSelectionAnchor;
    top: number;
    left: number;
  } | null>(null);
  const [commentEditorOpen, setCommentEditorOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const updateTextSelection = useCallback(() => {
    if (commentEditorOpen) {
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

    const range = selection.getRangeAt(0);
    const rect =
      typeof range.getBoundingClientRect === "function"
        ? range.getBoundingClientRect()
        : new DOMRect();
    setSelectionAction({
      anchor,
      top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 230)),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 312)),
    });
  }, [commentEditorOpen]);
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
  const handleLoadOlderMessages = useCallback(() => {
    const container = messagesContainerRef.current;
    if (
      !container ||
      !onLoadOlderMessages ||
      !hasOlderMessages ||
      isLoadingOlderMessages
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

    void onLoadOlderMessages().then((applied) => {
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
    });
  }, [hasOlderMessages, isLoadingOlderMessages, messages, onLoadOlderMessages]);

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
    keepAtBottomRef.current = true;
    userScrollRef.current = false;
    activeScrollGestureRef.current = false;
    lastScrollTopRef.current = messagesContainerRef.current?.scrollTop ?? null;
    prependAnchorRef.current = null;

    if (bottomFollowTimerRef.current !== null)
      clearTimeout(bottomFollowTimerRef.current);
    bottomFollowTimerRef.current = null;

    return () => {
      prependAnchorRef.current = null;
    };
  }, [sessionId]);

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
    if (!keepAtBottomRef.current) return;
    scheduleBottomFollow();
  }, [
    isLoadingOlderMessages,
    isWaiting,
    messages,
    streamingAssistant,
    scheduleBottomFollow,
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

    document.addEventListener("visibilitychange", scheduleBottomFollow);
    scheduleBottomFollow();

    return () => {
      disposed = true;

      observer?.disconnect();
      document.removeEventListener("visibilitychange", scheduleBottomFollow);

      if (bottomFollowTimerRef.current !== null)
        clearTimeout(bottomFollowTimerRef.current);
      bottomFollowTimerRef.current = null;
    };
  }, [sessionId, isVisible, scheduleBottomFollow]);

  useEffect(() => {
    const endGesture = () => {
      if (!activeScrollGestureRef.current) return;

      activeScrollGestureRef.current = false;

      const container = messagesContainerRef.current;
      if (
        container &&
        container.scrollHeight - container.clientHeight - container.scrollTop <=
          BOTTOM_SCROLL_TOLERANCE_PX
      ) {
        // The gesture finished near the bottom. Its intent must not outlive it
        // and turn a later viewport clamp into an upward user scroll. Read the
        // current position because the final gesture scroll may still be queued.
        userScrollRef.current = false;
      }

      scheduleBottomFollow();
    };

    const events = ["pointerup", "pointercancel", "touchend", "touchcancel"];
    for (const event of events) document.addEventListener(event, endGesture);

    return () => {
      for (const event of events)
        document.removeEventListener(event, endGesture);
    };
  }, [sessionId, scheduleBottomFollow]);

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
  }, [sessionId, beginUserScroll]);

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
          onWheel={(event) => {
            if (event.deltaY < 0) beginUserScroll();
          }}
          onTouchStart={() => {
            activeScrollGestureRef.current = true;

            beginUserScroll();
          }}
          onPointerDown={(event) => {
            // Scrollbar drags target the scroller; clicks in messages do not.
            if (event.target === event.currentTarget) {
              activeScrollGestureRef.current = true;

              beginUserScroll();
            }
          }}
          onKeyDown={(event) => {
            const target = event.target as HTMLElement;
            const editableTarget = target.closest(
              "input, textarea, [contenteditable=true]"
            );

            if (editableTarget) return;

            const upwardKeys = ["ArrowUp", "PageUp", "Home"];
            const isUpwardKey = upwardKeys.includes(event.key);
            const isReversePage = event.key === " " && event.shiftKey;

            if (isUpwardKey || isReversePage) beginUserScroll();
          }}
          onMouseUp={updateTextSelection}
          onKeyUp={updateTextSelection}
          onScroll={() => {
            const container = messagesContainerRef.current;
            if (container) {
              const scrollRange =
                container.scrollHeight - container.clientHeight;
              const max = Math.max(0, scrollRange);

              // Normalize elastic overscroll and compare against the current
              // range: shrink/clamping and bottom rebound are not user scrolls.
              const boundedTop = Math.min(container.scrollTop, max);
              const top = Math.max(0, boundedTop);
              const previous = lastScrollTopRef.current;
              const boundedPrevious =
                previous === null ? null : Math.min(previous, max);
              const nearBottom = max - top <= BOTTOM_SCROLL_TOLERANCE_PX;

              if (
                nearBottom &&
                (keepAtBottomRef.current ||
                  boundedPrevious === null ||
                  top > boundedPrevious)
              ) {
                keepAtBottomRef.current = true;
                if (!activeScrollGestureRef.current)
                  userScrollRef.current = false;
                scheduleBottomFollow();
              } else if (
                !nearBottom &&
                userScrollRef.current &&
                (boundedPrevious === null || top < boundedPrevious)
              ) {
                keepAtBottomRef.current = false;

                if (bottomFollowTimerRef.current !== null)
                  clearTimeout(bottomFollowTimerRef.current);
                bottomFollowTimerRef.current = null;
              }

              lastScrollTopRef.current = top;

              const anchor = prependAnchorRef.current;
              if (anchor) {
                anchor.scrollHeight = container.scrollHeight;
                anchor.scrollTop = container.scrollTop;
              }
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
            {(hasOlderMessages || isLoadingOlderMessages) && (
              <div className="flex justify-center">
                <button
                  type="button"
                  className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-fg-soft)] hover:bg-[var(--color-bg-hover)] disabled:cursor-wait disabled:opacity-60"
                  disabled={isLoadingOlderMessages}
                  onClick={handleLoadOlderMessages}
                >
                  {isLoadingOlderMessages
                    ? "Loading older messages…"
                    : "Load older messages"}
                </button>
              </div>
            )}
            {replayError && (
              <div
                className="text-center text-xs text-[var(--color-warn)]"
                role="status"
              >
                {replayError}
                <button type="button" onClick={() => retryHistory(sessionId)}>
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
                  className="fixed z-[80] flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-bg-1)] text-[var(--color-fg)] shadow-lg transition-colors hover:bg-[var(--color-bg-2)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                  data-testid="local-chat-add-comment"
                  aria-label="Add comment"
                  title="Add comment"
                  style={{
                    top: selectionAction.top,
                    left: selectionAction.left,
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setCommentDraft("");
                    setCommentEditorOpen(true);
                  }}
                >
                  <svg
                    aria-hidden="true"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.8}
                    viewBox="0 0 24 24"
                  >
                    <path d="M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5 8.6 8.6 0 0 1-4-.95L3 20l.95-4.55A8.5 8.5 0 1 1 20.5 11.5Z" />
                    <path d="M12 8.5v6M9 11.5h6" />
                  </svg>
                </button>,
                document.body
              )
            : null}
          {selectionAction && commentEditorOpen
            ? createPortal(
                <div
                  className="fixed z-[80] w-96 max-w-[calc(100vw-1rem)] rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] p-3 shadow-xl"
                  role="group"
                  aria-label="Add a comment to selected text"
                  style={{
                    top: selectionAction.top,
                    left: Math.max(
                      COMMENT_EDITOR_VIEWPORT_GUTTER_PX,
                      Math.min(
                        selectionAction.left,
                        window.innerWidth -
                          COMMENT_EDITOR_MAX_WIDTH_PX -
                          COMMENT_EDITOR_VIEWPORT_GUTTER_PX
                      )
                    ),
                  }}
                >
                  <label
                    htmlFor="local-chat-comment-draft"
                    className="mb-1 block text-xs font-medium text-[var(--color-fg)]"
                  >
                    Comment on selected text
                  </label>
                  <textarea
                    id="local-chat-comment-draft"
                    data-testid="local-chat-comment-draft"
                    aria-label="Comment on selected text"
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || !event.metaKey) return;
                      event.preventDefault();
                      submitCommentDraft();
                    }}
                    autoFocus
                    rows={3}
                    className="w-full resize-y rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] p-2 text-sm text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-xs text-[var(--color-fg-soft)] hover:bg-[var(--color-bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                      onClick={() => setCommentEditorOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      data-testid="local-chat-save-comment"
                      className="rounded-md bg-[var(--color-accent)] px-2 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
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
