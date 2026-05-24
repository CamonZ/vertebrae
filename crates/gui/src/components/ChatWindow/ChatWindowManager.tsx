import { useChatStore } from "../../stores/chatStore";
import { ResizablePanel } from "../ResizablePanel";
import { ChatWindow } from "./ChatWindow";
import { scopeLabel } from "../../utils/chatContext";

/**
 * ChatWindowManager manages multiple chat session tabs in a resizable side panel.
 * Renders tab headers and the active ChatWindow.
 */
export function ChatWindowManager() {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const focusSession = useChatStore((s) => s.focusSession);
  const closeSession = useChatStore((s) => s.closeSession);
  const togglePanel = useChatStore((s) => s.togglePanel);
  const detachSession = useChatStore((s) => s.detachSession);
  const reattachSession = useChatStore((s) => s.reattachSession);

  const sessionList = Object.values(sessions);
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;

  if (!panelOpen || sessionList.length === 0) {
    return null;
  }

  return (
    <ResizablePanel
      storageKey="chat-window-manager-width"
      defaultWidth={420}
      minWidth={320}
      glowColor="from-accent/0 via-accent/30 to-accent/0"
    >
      {/* Tab bar */}
      <div className="relative flex items-center border-b border-[var(--color-line)] bg-[var(--color-bg)]">
        {/* Neural grid background */}
        <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

        <div className="relative flex min-w-0 flex-1 items-center overflow-x-auto">
          {sessionList.map((session) => (
            <div
              key={session.id}
              role="tab"
              tabIndex={0}
              onClick={() => focusSession(session.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  focusSession(session.id);
                }
              }}
              className={`group relative flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-[var(--color-line)] px-3 py-2 text-xs transition-colors ${
                activeSessionId === session.id
                  ? "bg-[var(--color-bg-1)] text-[var(--color-fg)]"
                  : "text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg-soft)]"
              }`}
              title={`${scopeLabel(session.scope)}: ${session.label}`}
              aria-selected={activeSessionId === session.id}
            >
              {/* Active tab indicator */}
              {activeSessionId === session.id && (
                <span
                  data-testid="chat-tab-active-bar"
                  className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--color-accent)]"
                />
              )}

              {/* Scope icon */}
              <ScopeIcon scope={session.scope} />

              {/* Session label */}
              <span className="max-w-[100px] truncate">{session.label}</span>

              {/* Status dot */}
              {session.status === "open" && session.claudeSessionId && (
                <span
                  data-testid="chat-tab-active-dot"
                  className="h-1.5 w-1.5 rounded-full bg-[var(--color-ok)]"
                />
              )}
              {session.status === "closed" && (
                <span
                  data-testid="chat-tab-closed-dot"
                  className="h-1.5 w-1.5 rounded-full bg-[var(--color-fg-mute)]"
                />
              )}

              {session.isDetached && (
                <span
                  className="rounded bg-[var(--color-accent)]/15 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--color-accent)]"
                  title="Detached into pop-out window"
                >
                  detached
                </span>
              )}

              {!session.isDetached && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void detachSession(session.id);
                  }}
                  className="ml-0.5 rounded p-0.5 text-[var(--color-fg-mute)] opacity-0 transition-all hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] group-hover:opacity-100"
                  title="Detach into pop-out window"
                >
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M14 5h5v5M19 5l-7 7M5 5h4v2H7v10h10v-2h2v4H5z"
                    />
                  </svg>
                </button>
              )}

              {/* Close tab button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeSession(session.id);
                }}
                className="ml-0.5 rounded p-0.5 text-[var(--color-fg-mute)] opacity-0 transition-all hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] group-hover:opacity-100"
                title="Close tab"
              >
                <svg
                  className="h-3 w-3"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>

        {/* Close panel button */}
        <button
          onClick={togglePanel}
          className="shrink-0 rounded p-1.5 text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
          title="Close chat panel"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5l7 7-7 7"
            />
          </svg>
        </button>
      </div>

      {/* Active chat window — show a placeholder if the session has been
          detached into a pop-out so we don't double-render its history. */}
      {activeSession?.isDetached && (
        <DetachedPlaceholder
          label={activeSession.label}
          onReattach={() => reattachSession(activeSession.id)}
        />
      )}
      {activeSession && !activeSession.isDetached && (
        <ChatWindow sessionId={activeSession.id} />
      )}
    </ResizablePanel>
  );
}

/**
 * Placeholder shown in the main panel when the active tab's session has
 * been detached into a pop-out window. Offers a one-click reattach.
 */
function DetachedPlaceholder({
  label,
  onReattach,
}: {
  label: string;
  onReattach: () => void;
}) {
  return (
    <div
      role="status"
      aria-label="Session detached"
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <span className="rounded-full bg-[var(--color-accent)]/10 p-3 text-[var(--color-accent)]">
        <svg
          className="h-6 w-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M14 5h5v5M19 5l-7 7M5 5h4v2H7v10h10v-2h2v4H5z"
          />
        </svg>
      </span>
      <p className="text-sm text-[var(--color-fg-soft)]">
        <span className="font-medium text-[var(--color-fg)]">{label}</span> is open
        in a pop-out window
      </p>
      <button
        onClick={onReattach}
        className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg-1)] px-3 py-1.5 text-xs text-[var(--color-fg)] transition-colors hover:bg-[var(--color-bg-3)]"
      >
        Reattach to panel
      </button>
    </div>
  );
}

/**
 * Small icon for each scope type used in tab headers
 */
function ScopeIcon({ scope }: { scope: string }) {
  switch (scope) {
    case "project":
      return (
        <svg
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
          />
        </svg>
      );
    case "workflow":
      return (
        <svg
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>
      );
    case "task":
      return (
        <svg
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
          />
        </svg>
      );
    case "step":
      return (
        <svg
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
          />
        </svg>
      );
    default:
      return null;
  }
}
