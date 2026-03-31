import { useCallback } from "react";
import { useOpenChat } from "../hooks/useScopedChat";
import type { ChatScope } from "../stores/chatStore";

interface OpenChatButtonProps {
  scope: ChatScope;
  entityId: string | null;
  label: string;
  className?: string;
}

/**
 * Reusable button to open a scoped chat session from any entity detail panel.
 */
export function OpenChatButton({
  scope,
  entityId,
  label,
  className = "",
}: OpenChatButtonProps) {
  const openChat = useOpenChat();

  const handleClick = useCallback(() => {
    openChat(scope, entityId, label);
  }, [openChat, scope, entityId, label]);

  return (
    <button
      onClick={handleClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 ${className}`}
      title={`Open chat for this ${scope}`}
    >
      <svg
        className="h-3.5 w-3.5"
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
      Chat
    </button>
  );
}
