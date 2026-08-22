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
 * Choice shown before opening a new project chat when durable history exists.
 * The existing session is represented by a link so the action is explicitly a
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
      className="hc-launch-prompt"
      data-testid="local-chat-resume-prompt"
      role="dialog"
      aria-label="Choose a local chat"
    >
      <p>
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
        <button
          type="button"
          disabled={busy}
          onClick={() => void onNewChat()}
        >
          new chat
        </button>
      </p>
      {error && (
        <div role="alert" className="hc-launch-prompt-error">
          {error}
        </div>
      )}
    </div>
  );
}
