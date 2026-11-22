import {
  CHAT_ATTENTION,
  chatAttentionText,
  type ChatAttention,
} from "../../utils/chatAttention";

interface ChatAttentionDotProps {
  attention: ChatAttention;
  /** Prefixes the accessible name and tooltip, e.g. the chat title. */
  subject?: string;
  testId?: string;
}

/**
 * The 6px status dot shared by every surface that shows a chat: pane header,
 * history row and compact panel. Its state and reason are the tooltip and
 * accessible name, so color is never the only carrier. Idle draws nothing.
 */
export function ChatAttentionDot({
  attention,
  subject,
  testId = "chat-attention-dot",
}: ChatAttentionDotProps) {
  const { tone } = CHAT_ATTENTION[attention.state];
  if (!tone) return null;
  const text = chatAttentionText(attention);
  const label = subject ? `${subject}: ${text}` : text;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="chat-attention-dot"
      data-attention={attention.state}
      data-tone={tone}
      data-testid={testId}
    />
  );
}
