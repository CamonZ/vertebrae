import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";
import { localChatSessionDisplayTitle } from "../../utils/localChatSessionGroups";

interface ChatResumePromptProps {
  session: Pick<LocalChatSessionSummary, "id" | "label" | "title">;
  error?: string | null;
  busy?: boolean;
  onContinue: () => void | Promise<void>;
  onNewChat: () => void | Promise<void>;
}

/**
 * Notice shown inside the project chat panel when durable history exists. The
 * existing session is represented by a link so the action is explicitly a
 * resume/focus operation rather than an implicit new-session copy.
 */
export function ChatResumePrompt({
  session,
  error,
  busy = false,
  onContinue,
  onNewChat,
}: ChatResumePromptProps) {
  const title = localChatSessionDisplayTitle(session);

  return (
    <div
      className="hc-resume-prompt"
      data-testid="local-chat-resume-prompt"
      role="status"
      aria-live="polite"
    >
      <p className="text-sm font-normal text-[var(--color-fg-soft)]">
        <a
          href={`#local-chat-resume-${encodeURIComponent(session.id)}`}
          aria-disabled={busy}
          onClick={(event) => {
            event.preventDefault();
            if (busy) return;
            void onContinue();
          }}
        >
          continue with the last session {title}
        </a>{" "}
        <span>or</span>{" "}
        <button type="button" disabled={busy} onClick={() => void onNewChat()}>
          new chat
        </button>
      </p>
      {error && (
        <div role="alert" className="hc-resume-prompt-error">
          {error}
        </div>
      )}
    </div>
  );
}
