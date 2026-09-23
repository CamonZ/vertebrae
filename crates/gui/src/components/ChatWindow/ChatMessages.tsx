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
import { commands } from "../../bindings";
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

function isNearBottom(element: HTMLElement): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    BOTTOM_SCROLL_TOLERANCE_PX
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
  messages: readonly ChatMessage[],
  assistantLabel: string,
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
    items.push({
      kind: "thread",
      key: `thread-${segmentSeq++}`,
      thread: chatMessagesToThread(segment, {
        assistantLabel,
        expanded: expandedToolIds,
        onToggleTool,
        fullContent: fullContentToolIds,
        onToggleFullContent,
      }),
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
  registerRef: (id: string, element: HTMLElement | null) => void;
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
      <EventLog key={item.key} mode="bare">
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

interface ChatMessagesProps {
  sessionId: string;
  projectPath?: string | null;
  messages: readonly ChatMessage[];
  assistantLabel: string;
  isEmpty: boolean;
  isActive: boolean;
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
}

export function ChatMessages({
  sessionId,
  projectPath,
  messages,
  assistantLabel,
  isEmpty,
  isActive,
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
}: ChatMessagesProps) {
  const resolveUserQuestion = useChatStore(
    (state) => state.resolveUserQuestion
  );
  const markUserQuestionUnavailable = useChatStore(
    (state) => state.markUserQuestionUnavailable
  );
  const thinkingIndicatorStyle = useUIStore(
    (state) => state.thinkingIndicatorStyle
  );
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const latestMessagesRef = useRef(messages);
  latestMessagesRef.current = messages;
  const prependAnchorRef = useRef<{
    messages: readonly ChatMessage[];
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const keepAtBottomRef = useRef(true);
  const [projectRoots, setProjectRoots] = useState<readonly string[]>(
    projectPath ? [projectPath] : []
  );
  // This state lives above individual rows so future virtualization can
  // unmount/remount them without discarding the user's expansion choices.
  const [expandedToolIds, setExpandedToolIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [fullContentToolIds, setFullContentToolIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [selectionAction, setSelectionAction] = useState<{
    anchor: TextSelectionAnchor;
    top: number;
    left: number;
  } | null>(null);
  const [commentEditorOpen, setCommentEditorOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
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
    prependAnchorRef.current = {
      messages,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    };
    keepAtBottomRef.current = false;
    void onLoadOlderMessages().then((applied) => {
      if (!applied) {
        prependAnchorRef.current = null;
        return;
      }
      requestAnimationFrame(() => {
        const anchor = prependAnchorRef.current;
        if (anchor?.messages === latestMessagesRef.current) {
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

  const renderItems = useMemo(
    () =>
      buildChatRenderItems(
        messages,
        assistantLabel,
        expandedToolIds,
        toggleTool,
        fullContentToolIds,
        toggleFullContent
      ),
    [
      assistantLabel,
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
      prependAnchorRef.current = null;
      return;
    }
    if (!keepAtBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [isLoadingOlderMessages, isWaiting, messages, streamingAssistant]);

  useEffect(() => {
    const handleScrollToSpawn = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          sessionId?: string;
          spawnId?: string;
        }>
      ).detail;
      if (detail?.sessionId !== sessionId || !detail.spawnId) return;
      messageRefs.current
        .get(detail.spawnId)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
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
  }, [sessionId]);

  return (
    <MarkdownProjectRootProvider
      projectPath={projectPath}
      projectRoots={projectRoots}
    >
      <div
        ref={messagesContainerRef}
        className="min-h-0 flex-1 overflow-y-auto p-4"
        data-testid="chat-messages-scroll"
        onMouseUp={updateTextSelection}
        onKeyUp={updateTextSelection}
        onScroll={() => {
          const container = messagesContainerRef.current;
          if (container) {
            keepAtBottomRef.current = isNearBottom(container);
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
        <div className="flex flex-col gap-3">
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
            </div>
          )}
          <HistoricalChatItems
            items={renderItems}
            sessionId={sessionId}
            isActive={isActive}
            registerRef={registerMessageRef}
            resolveUserQuestion={resolveUserQuestion}
            markUserQuestionUnavailable={markUserQuestionUnavailable}
          />
          {streamingTail && (
            <div data-testid="chat-streaming-tail">
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
            </div>
          )}
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
        </div>
        {selectionAction && !commentEditorOpen
          ? createPortal(
              <button
                type="button"
                className="fixed z-[80] flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-bg-1)] text-[var(--color-fg)] shadow-lg transition-colors hover:bg-[var(--color-bg-2)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                data-testid="local-chat-add-comment"
                aria-label="Add comment"
                title="Add comment"
                style={{ top: selectionAction.top, left: selectionAction.left }}
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
                className="fixed z-[80] w-72 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] p-3 shadow-xl"
                role="group"
                aria-label="Add a comment to selected text"
                style={{ top: selectionAction.top, left: selectionAction.left }}
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
                    onClick={() => {
                      onAddComment(selectionAction.anchor, commentDraft.trim());
                      setCommentEditorOpen(false);
                      setSelectionAction(null);
                      window.getSelection()?.removeAllRanges();
                    }}
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
  );
}
