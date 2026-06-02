import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useGlassPanel } from "../../hooks/useGlassPanel";
import { usePanelExitTransition } from "../../hooks/usePanelExitTransition";
import { ChatWindow } from "./ChatWindow";

/** Floating chat-panel width: persistence key and clamp bounds (px). Mirrors
 * the task-detail panel's horizontal resize (TaskDetailPanel.tsx). */
const WIDTH_STORAGE_KEY = "chat-window-manager-width";
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 760;
const DEFAULT_PANEL_WIDTH = 384;
/** Keyboard resize step (px) for the drag handle. */
const RESIZE_STEP = 16;
/** Exit-animation duration (ms). Must match `.hc-panel.is-closing` (--t-base). */
const EXIT_MS = 180;

/**
 * ChatWindowManager manages multiple chat session tabs in a floating-glass side
 * panel anchored bottom-left (design reference `.hc-panel`, opened by the
 * FloatingChatLauncher pill). Renders the active session's ChatWindow, which
 * owns the single header band (title + scope) and the composer.
 */
export function ChatWindowManager() {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const togglePanel = useChatStore((s) => s.togglePanel);
  const reattachSession = useChatStore((s) => s.reattachSession);

  // Horizontal resize. The panel is left-anchored, so a drag on its right edge
  // widens it as the cursor moves right. We measure the panel's fixed left edge
  // from the DOM rather than assuming the inset value.
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
    const stored = parseInt(localStorage.getItem(WIDTH_STORAGE_KEY) ?? "", 10);
    return Number.isNaN(stored)
      ? DEFAULT_PANEL_WIDTH
      : Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, stored));
  });
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(panelWidth));
    }
  }, [panelWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (event: MouseEvent) => {
      const leftEdge = panelRef.current?.getBoundingClientRect().left ?? 0;
      setPanelWidth(
        Math.min(
          MAX_PANEL_WIDTH,
          Math.max(MIN_PANEL_WIDTH, event.clientX - leftEdge)
        )
      );
    };
    const onUp = () => setIsResizing(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing]);

  const sessionList = Object.values(sessions);
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;

  const open = panelOpen && sessionList.length > 0;

  // Join the shared glass-panel focus model so Escape closes whichever panel is
  // focused. The chat is globally mounted; it's "open" only while showing.
  const { isFocused, focusProps } = useGlassPanel({
    id: "chat",
    isOpen: open,
    onClose: togglePanel,
  });

  // Defer unmount so the panel can drill back out to the edge on close. Sessions
  // persist in the store through the close, so content stays put while it exits.
  const { mounted, closing, onAnimationEnd } = usePanelExitTransition(
    open,
    EXIT_MS
  );

  if (!mounted) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      className={`hc-panel${closing ? " is-closing" : ""}`}
      style={{ width: `${panelWidth}px` }}
      data-testid="chat-window-manager"
      data-focused={isFocused || undefined}
      data-closing={closing || undefined}
      onAnimationEnd={onAnimationEnd}
      {...focusProps}
    >
      {/* Right-edge drag handle for horizontal resize */}
      <div
        className="hc-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={panelWidth}
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={MAX_PANEL_WIDTH}
        tabIndex={0}
        data-resizing={isResizing || undefined}
        data-testid="chat-resize-handle"
        onMouseDown={(event) => {
          event.preventDefault();
          setIsResizing(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            setPanelWidth((w) => Math.min(MAX_PANEL_WIDTH, w + RESIZE_STEP));
          } else if (event.key === "ArrowLeft") {
            setPanelWidth((w) => Math.max(MIN_PANEL_WIDTH, w - RESIZE_STEP));
          }
        }}
      />
      {/* Active chat window — owns the single header band, message thread, and
          composer. A detached session shows a reattach placeholder instead so we
          don't double-render its history into a pop-out. */}
      {activeSession?.isDetached && (
        <DetachedPlaceholder
          label={activeSession.label}
          onReattach={() => reattachSession(activeSession.id)}
        />
      )}
      {activeSession && !activeSession.isDetached && (
        <ChatWindow sessionId={activeSession.id} onClosePanel={togglePanel} />
      )}
    </div>
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

