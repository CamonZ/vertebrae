import type { ReactNode } from "react";

export type ChatRole = "user" | "assistant" | "system";

interface ChatMessageProps {
  role: ChatRole;
  /** Author label rendered above the bubble (e.g. "You", "Claude · sonnet"). */
  author?: ReactNode;
  /** Absolute timestamp; shown in a hover tooltip. */
  timestamp?: string;
  /** Streaming bubbles render a blinking cursor at the end of the content. */
  streaming?: boolean;
  children: ReactNode;
  className?: string;
}

const roleClasses: Record<ChatRole, string> = {
  user:
    "ml-auto bg-[var(--color-accent-wash)] text-[var(--color-fg)] border-[color-mix(in_oklch,var(--color-accent)_35%,transparent)]",
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
        "flex max-w-[78%] flex-col gap-1",
        role === "user" ? "items-end" : role === "system" ? "items-center" : "items-start",
        role === "user" ? "ml-auto" : role === "assistant" ? "mr-auto" : "mx-auto",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {author && (
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-fg-mute)]">
          {author}
        </span>
      )}
      <div
        title={timestamp}
        className={[
          "rounded-[var(--radius-lg)] border px-3 py-2 font-sans text-sm leading-relaxed",
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
