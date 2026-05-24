import type { ReactNode } from "react";

export type ChatRole = "user" | "assistant" | "system";

interface ChatMessageProps {
  role: ChatRole;
  /** Author label rendered above the bubble (e.g. "You", "Claude · sonnet"). */
  author?: ReactNode;
  /** Pre-formatted timestamp; rendered visibly next to the author and also as a hover tooltip on the bubble. */
  timestamp?: string;
  /** Streaming bubbles render a blinking cursor at the end of the content. */
  streaming?: boolean;
  children: ReactNode;
  className?: string;
}

const roleClasses: Record<ChatRole, string> = {
  user:
    "ml-auto bg-[var(--color-bg-2)] text-[var(--color-fg)] border-[var(--color-line)]",
  assistant:
    "mr-auto bg-[var(--color-bg-2)] text-[var(--color-fg)] border-[var(--color-line)]",
  system:
    "mx-auto bg-transparent text-[var(--color-fg-mute)] border-dashed border-[var(--color-line)] italic",
};

/**
 * One turn in an AI conversation. Role is conveyed by alignment + tint — no
 * avatar. Tool call children render inside the bubble below the message text.
 */
export function ChatMessage({
  role,
  author,
  timestamp,
  streaming,
  children,
  className,
}: ChatMessageProps) {
  return (
    <div
      className={[
        "flex min-w-0 max-w-[78%] flex-col gap-1",
        role === "user" ? "items-end" : role === "system" ? "items-center" : "items-start",
        role === "user" ? "ml-auto" : role === "assistant" ? "mr-auto" : "mx-auto",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {(author || timestamp) && (
        <div className="flex items-baseline gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-fg-mute)]">
          {author && <span>{author}</span>}
          {timestamp && (
            <span className="tracking-normal normal-case text-[var(--color-fg-faint)]">
              {timestamp}
            </span>
          )}
        </div>
      )}
      <div
        title={timestamp}
        className={[
          "min-w-0 max-w-full rounded-[var(--radius-lg)] border px-3 py-2 font-sans text-sm leading-relaxed",
          "whitespace-pre-wrap break-words",
          roleClasses[role],
        ].join(" ")}
      >
        {children}
        {streaming && (
          <span
            aria-hidden
            className="ml-0.5 inline-block h-3 w-[2px] translate-y-0.5 animate-pulse bg-[var(--color-accent)]"
          />
        )}
      </div>
    </div>
  );
}
