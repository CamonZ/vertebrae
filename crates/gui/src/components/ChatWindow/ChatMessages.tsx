import { useEffect, useMemo, useRef } from "react";
import type { ChatMessage } from "../../stores/chatStore";
import { Thread } from "../thread";
import type { ThreadModel } from "../thread";
import { chatMessagesToThread } from "./chatMessagesToThread";
import { PermissionRequestTurn } from "./PermissionRequestTurn";
import { ThinkingIndicator } from "./ThinkingIndicator";

const LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT = "local-chat-scroll-to-spawn";

type ChatRenderItem =
  | { kind: "thread"; key: string; thread: ThreadModel }
  | {
      kind: "permission";
      key: string;
      message: Extract<ChatMessage, { kind: "permission_request" }>;
    };

function buildChatRenderItems(
  messages: readonly ChatMessage[],
  assistantLabel: string
): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  let segment: ChatMessage[] = [];
  let segmentSeq = 0;

  // Pull sub-agent (sidechain) tool messages out of the main chronological
  // stream and key them by their spawning Task tool. Otherwise a permission
  // segment boundary that falls between a spawn and its children splits the
  // spawn group, and the children render as orphaned threads dumped at the
  // bottom. The spawn's parent tool_call stays in the main stream, so the
  // sub-agent re-nests at its chronological position (see chatMessagesToThread).
  const childrenByParent = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const parent =
      (message.kind === "assistant" ||
        message.kind === "tool_call" ||
        message.kind === "tool_result") &&
      message.parentToolUseId
        ? message.parentToolUseId
        : undefined;
    if (!parent) continue;
    const group = childrenByParent.get(parent);
    if (group) group.push(message);
    else childrenByParent.set(parent, [message]);
  }

  const flushSegment = () => {
    if (segment.length === 0) return;
    items.push({
      kind: "thread",
      key: `thread-${segmentSeq++}`,
      thread: chatMessagesToThread(segment, {
        childrenByParent,
        assistantLabel,
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

    // Sub-agent messages are re-injected via childrenByParent at their parent
    // spawn's position; keep them out of the main segment stream.
    if (
      (message.kind === "assistant" ||
        message.kind === "tool_call" ||
        message.kind === "tool_result") &&
      message.parentToolUseId
    ) {
      return;
    }

    segment.push(message);
  });

  flushSegment();
  return items;
}

interface ChatMessagesProps {
  sessionId: string;
  messages: readonly ChatMessage[];
  assistantLabel: string;
  isEmpty: boolean;
  isActive: boolean;
  isWaiting: boolean;
  streamingAssistant: unknown;
}

export function ChatMessages({
  sessionId,
  messages,
  assistantLabel,
  isEmpty,
  isActive,
  isWaiting,
  streamingAssistant,
}: ChatMessagesProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());

  const renderItems = useMemo(
    () => buildChatRenderItems(messages, assistantLabel),
    [assistantLabel, messages]
  );

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingAssistant]);

  useEffect(() => {
    const handleScrollToSpawn = (event: Event) => {
      const detail = (event as CustomEvent<{
        sessionId?: string;
        spawnId?: string;
      }>).detail;
      if (detail?.sessionId !== sessionId || !detail.spawnId) return;
      messageRefs.current
        .get(detail.spawnId)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    window.addEventListener(LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT, handleScrollToSpawn);
    return () =>
      window.removeEventListener(
        LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT,
        handleScrollToSpawn
      );
  }, [sessionId]);

  return (
    <div className="flex-1 overflow-y-auto p-4">
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
        {renderItems.map((item) =>
          item.kind === "thread" ? (
            <Thread
              key={item.key}
              thread={item.thread}
              depth={0}
              mode="bare"
              reveal="shallow"
              showHead={false}
              interactive
              registerRef={(id, element) => {
                if (element) {
                  messageRefs.current.set(id, element);
                } else {
                  messageRefs.current.delete(id);
                }
              }}
            />
          ) : (
            <PermissionRequestTurn key={item.key} message={item.message} />
          )
        )}
        {isWaiting && <ThinkingIndicator />}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
