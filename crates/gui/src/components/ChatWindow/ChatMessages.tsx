import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { ThinkingIndicator } from "./ThinkingIndicator";
import { MarkdownProjectRootProvider } from "../shared/MarkdownContent";

const LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT = "local-chat-scroll-to-spawn";
const BOTTOM_SCROLL_TOLERANCE_PX = 24;

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
  isWaiting: boolean;
  activityLabel?: string | null;
  compactionSummary?: ChatCompactionSummary | null;
  streamingAssistant: StreamingAssistantMessage | null;
}

export function ChatMessages({
  sessionId,
  projectPath,
  messages,
  assistantLabel,
  isEmpty,
  isActive,
  isWaiting,
  activityLabel,
  compactionSummary,
  streamingAssistant,
}: ChatMessagesProps) {
  const resolveUserQuestion = useChatStore(
    (state) => state.resolveUserQuestion
  );
  const markUserQuestionUnavailable = useChatStore(
    (state) => state.markUserQuestionUnavailable
  );
  const messagesContainerRef = useRef<HTMLDivElement>(null);
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
    if (!container || !keepAtBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [isWaiting, messages, streamingAssistant]);

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
        onScroll={() => {
          const container = messagesContainerRef.current;
          if (container) keepAtBottomRef.current = isNearBottom(container);
        }}
      >
        {isEmpty && !isActive && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-accent)]/10">
              <svg
                className="h-6 w-6 text-[var(--color-accent)]"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
            </div>
            <p className="text-sm text-[var(--color-fg-soft)]">
              Create, edit, and delete tasks, steps, and workflows
            </p>
            <p className="mt-1 text-xs text-[var(--color-fg-mute)]">
              Or run a task through a workflow
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3">
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
            <ThinkingIndicator label={activityLabel ?? undefined} />
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
      </div>
    </MarkdownProjectRootProvider>
  );
}
