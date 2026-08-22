import { useCallback, useEffect, useState } from "react";
import { commands } from "../../bindings";
import { useChatStore } from "../../stores/chatStore";
import { ChatResumePrompt } from "./ChatResumePrompt";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";

/** Max gap (ms) between the two Alt taps that toggle the chat. */
const DOUBLE_TAP_MS = 400;

async function loadCurrentProjectPath(): Promise<string | null> {
  try {
    const result = await commands.getCurrentProjectPath();
    return result.status === "ok" && result.data ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Floating launcher pill for the project chat, adapted from the design
 * reference (docs/design/lib/lib-chat.jsx `.hc-launch`). Floats bottom-right
 * at the same edge as chat, and is shown only while the panel is closed —
 * clicking it (or double-tapping Alt) opens the claude-binary project chat
 * (chatStore) in the floating-glass panel (ChatWindowManager).
 *
 * The pill itself carries no label; it shows a keyboard hint (⌥ ⌥) the way the
 * search box shows `/`. The Alt-Alt listener lives here rather than in the pill
 * markup so it stays armed even while the panel is open (this component is
 * always mounted by AppShell and only its render returns null) — making the
 * shortcut a true open/close toggle.
 */
export function FloatingChatLauncher() {
  const togglePanel = useChatStore((s) => s.togglePanel);
  const findLatestResumableSession = useChatStore(
    (s) => s.findLatestResumableSession
  );
  const selectPersistedSession = useChatStore((s) => s.selectPersistedSession);
  const startFreshSession = useChatStore((s) => s.startFreshSession);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const [resumeCandidate, setResumeCandidate] =
    useState<LocalChatSessionSummary | null>(null);
  const [resumeProjectPath, setResumeProjectPath] = useState<string | null>(
    null
  );
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [choiceBusy, setChoiceBusy] = useState(false);

  // Open (and ensure a session) when closed; close when already open. Reads
  // panelOpen from the store at call time so it works from the key handler too.
  const toggleChat = useCallback(async () => {
    if (useChatStore.getState().panelOpen) {
      setResumeCandidate(null);
      setResumeError(null);
      togglePanel();
      return;
    }

    const projectPath = await loadCurrentProjectPath();
    if (useChatStore.getState().panelOpen) return;

    const candidate = await findLatestResumableSession(projectPath);
    if (candidate) {
      setResumeProjectPath(projectPath);
      setResumeCandidate(candidate);
      setResumeError(null);
      return;
    }

    startFreshSession("New Chat", projectPath);
  }, [findLatestResumableSession, startFreshSession, togglePanel]);

  const continueLastSession = useCallback(async () => {
    if (!resumeCandidate || choiceBusy) return;
    setChoiceBusy(true);
    setResumeError(null);
    try {
      const selected = await selectPersistedSession(resumeCandidate.id);
      if (!selected) {
        setResumeError(
          "Could not continue that session. You can still start a new chat."
        );
        return;
      }
      setResumeCandidate(null);
    } finally {
      setChoiceBusy(false);
    }
  }, [choiceBusy, resumeCandidate, selectPersistedSession]);

  const startNewChat = useCallback(() => {
    if (choiceBusy) return;
    setChoiceBusy(true);
    startFreshSession("New Chat", resumeProjectPath);
    setResumeCandidate(null);
    setResumeError(null);
    setChoiceBusy(false);
  }, [choiceBusy, resumeProjectPath, startFreshSession]);

  // Double-tap Alt to toggle. Ignore auto-repeat from a held key; use the
  // event's monotonic timeStamp to measure the gap between discrete presses.
  useEffect(() => {
    let lastAlt: number | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Alt" || event.repeat) return;
      if (lastAlt !== null && event.timeStamp - lastAlt < DOUBLE_TAP_MS) {
        lastAlt = null;
        void toggleChat();
      } else {
        lastAlt = event.timeStamp;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleChat]);

  // While the panel is open it owns the bottom-right anchor; hide the pill.
  if (panelOpen) return null;

  if (resumeCandidate) {
    return (
      <ChatResumePrompt
        session={resumeCandidate}
        error={resumeError}
        busy={choiceBusy}
        onContinue={continueLastSession}
        onNewChat={startNewChat}
      />
    );
  }

  return (
    <button
      type="button"
      className="hc-launch"
      data-testid="local-chat-launcher"
      onClick={() => void toggleChat()}
      title="Open project chat (⌥ ⌥)"
      aria-label="Open project chat"
    >
      <span className="ic" aria-hidden>
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </span>
      <span className="hint" aria-hidden>
        <kbd className="key">⌥</kbd>
        <kbd className="key">⌥</kbd>
      </span>
      <span className="ember" aria-hidden />
    </button>
  );
}
