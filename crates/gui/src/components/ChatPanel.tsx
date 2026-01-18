import { useCallback, useEffect, useRef, useState } from "react";
import {
  Terminal,
  type TerminalHandle,
  type TerminalDimensions,
} from "./Terminal/Terminal";
import { usePtySession } from "../hooks/usePtySession";
import { commands } from "../bindings";
import { useUIStore } from "../stores";

// Default width in pixels (approximately 1/4 of a 1920px screen)
const DEFAULT_WIDTH = 480;
// Min/max as fractions of window width
const MIN_WIDTH_FRACTION = 0.25;
const MAX_WIDTH_FRACTION = 0.33;

/**
 * ChatPanel provides a resizable terminal interface.
 * Renders as a left-side panel with drag-to-resize capability.
 * Users can run any commands including Claude Code.
 */
export function ChatPanel() {
  const terminalRef = useRef<TerminalHandle>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [workingDir, setWorkingDir] = useState<string | null>(null);
  const [isLoadingProject, setIsLoadingProject] = useState(true);
  const initialDimensionsRef = useRef<TerminalDimensions | null>(null);

  // Panel state from store
  const chatPanelOpen = useUIStore((s) => s.chatPanelOpen);
  const chatPanelWidth = useUIStore((s) => s.chatPanelWidth);
  const setChatPanelWidth = useUIStore((s) => s.setChatPanelWidth);
  const toggleChatPanel = useUIStore((s) => s.toggleChatPanel);

  // Resize state
  const [isResizing, setIsResizing] = useState(false);

  // Handle PTY output - decode base64 and write to terminal
  const handlePtyOutput = useCallback((data: string) => {
    if (!terminalRef.current) return;

    try {
      // Decode base64 to bytes
      const decoded = atob(data);
      // Convert to Uint8Array for proper binary handling
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) {
        bytes[i] = decoded.charCodeAt(i);
      }
      terminalRef.current.write(bytes);
    } catch (error) {
      console.error("Failed to decode PTY output:", error);
    }
  }, []);

  // Handle PTY exit
  const handlePtyExit = useCallback(
    (exitCode: number | null, error: string | null) => {
      if (terminalRef.current) {
        terminalRef.current.write(
          `\r\n\x1b[33m--- Session ended${exitCode !== null ? ` (exit code: ${exitCode})` : ""}${error ? ` [${error}]` : ""} ---\x1b[0m\r\n`
        );
      }
    },
    []
  );

  const {
    state,
    error,
    createSession,
    writeToSession,
    resizeSession,
    closeSession,
    isActive,
    hasEnded,
  } = usePtySession({
    workingDir: workingDir ?? undefined,
    onOutput: handlePtyOutput,
    onExit: handlePtyExit,
  });

  // Load current project working directory
  useEffect(() => {
    async function loadProject() {
      const result = await commands.getCurrentProject();
      if (result.status === "ok" && result.data) {
        setWorkingDir(result.data);
      }
      setIsLoadingProject(false);
    }
    loadProject();
  }, []);

  // Auto-start session when terminal is ready and project is loaded
  useEffect(() => {
    if (
      !isLoadingProject &&
      chatPanelOpen &&
      state === "idle" &&
      initialDimensionsRef.current
    ) {
      createSession(initialDimensionsRef.current);
    }
  }, [isLoadingProject, chatPanelOpen, state, createSession]);

  // Handle terminal data (user input)
  const handleTerminalData = useCallback(
    (data: string) => {
      if (isActive) {
        writeToSession(data);
      }
    },
    [isActive, writeToSession]
  );

  // Handle terminal resize
  const handleTerminalResize = useCallback(
    (dimensions: TerminalDimensions) => {
      // Store initial dimensions for session creation
      if (!initialDimensionsRef.current) {
        initialDimensionsRef.current = dimensions;
      }

      if (isActive) {
        resizeSession(dimensions);
      }
    },
    [isActive, resizeSession]
  );

  // Start a new session
  const handleNewSession = useCallback(async () => {
    if (isActive) {
      await closeSession();
    }

    // Clear terminal and start fresh
    if (terminalRef.current) {
      terminalRef.current.clear();
    }

    // Wait a moment for cleanup, then create new session
    setTimeout(() => {
      const dims = terminalRef.current?.getDimensions() ?? {
        cols: 80,
        rows: 24,
      };
      createSession(dims);
    }, 100);
  }, [isActive, closeSession, createSession]);

  // Clear terminal
  const handleClear = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.clear();
    }
  }, []);

  // Close session
  const handleClose = useCallback(() => {
    closeSession();
  }, [closeSession]);

  // Focus terminal when panel opens
  useEffect(() => {
    if (chatPanelOpen) {
      const timer = setTimeout(() => {
        terminalRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [chatPanelOpen]);

  // Handle resize drag
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  // Handle resize movement
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const windowWidth = window.innerWidth;
      const minWidth = windowWidth * MIN_WIDTH_FRACTION;
      const maxWidth = windowWidth * MAX_WIDTH_FRACTION;

      // Calculate new width based on mouse position (accounting for sidebar)
      // Sidebar is 64px when collapsed
      const newWidth = Math.min(Math.max(e.clientX - 64, minWidth), maxWidth);
      setChatPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, setChatPanelWidth]);

  // Clamp width on window resize
  useEffect(() => {
    const handleResize = () => {
      const windowWidth = window.innerWidth;
      const minWidth = windowWidth * MIN_WIDTH_FRACTION;
      const maxWidth = windowWidth * MAX_WIDTH_FRACTION;
      const clampedWidth = Math.min(
        Math.max(chatPanelWidth, minWidth),
        maxWidth
      );
      if (clampedWidth !== chatPanelWidth) {
        setChatPanelWidth(clampedWidth);
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [chatPanelWidth, setChatPanelWidth]);

  if (!chatPanelOpen) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      className="relative flex flex-col border-r border-border bg-bg-primary"
      style={{ width: chatPanelWidth || DEFAULT_WIDTH }}
    >
      {/* Header with session controls */}
      <div className="relative flex items-center justify-between border-b border-border bg-bg-primary px-4 py-2">
        {/* Neural grid background */}
        <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

        <div className="relative flex items-center gap-3">
          <h2 className="text-sm font-semibold text-text-primary">
            Terminal
          </h2>

          {/* Session status indicator */}
          {state === "starting" && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          )}
          {isActive && (
            <span className="relative flex h-2 w-2">
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
          )}
          {hasEnded && (
            <span className="relative inline-flex h-2 w-2 rounded-full bg-text-muted" />
          )}
          {state === "error" && (
            <span className="relative inline-flex h-2 w-2 rounded-full bg-error" />
          )}
        </div>

        {/* Session control buttons */}
        <div className="relative flex items-center gap-1">
          <button
            onClick={handleNewSession}
            className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            title="Start new session"
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
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
          <button
            onClick={handleClear}
            className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            title="Clear terminal"
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
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </button>
          {isActive && (
            <button
              onClick={handleClose}
              className="rounded p-1.5 text-error transition-colors hover:bg-error/10"
              title="Close session"
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
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
          <div className="mx-1 h-4 w-px bg-border" />
          <button
            onClick={toggleChatPanel}
            className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            title="Close panel"
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
                d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Error message */}
      {error && state === "error" && (
        <div className="border-b border-error/30 bg-error/10 px-4 py-2">
          <p className="text-xs text-error">Failed to start session: {error}</p>
          <button
            onClick={handleNewSession}
            className="mt-1 text-xs font-medium text-error underline hover:no-underline"
          >
            Try again
          </button>
        </div>
      )}

      {/* Terminal area */}
      <div className="flex-1 overflow-hidden bg-[#09090b] p-2">
        {isLoadingProject ? (
          <div className="flex h-full items-center justify-center">
            <span className="text-text-secondary">Loading project...</span>
          </div>
        ) : (
          <Terminal
            ref={terminalRef}
            onData={handleTerminalData}
            onResize={handleTerminalResize}
            autoFocus={true}
            theme="dark"
          />
        )}
      </div>

      {/* Footer with working directory info */}
      <div className="flex items-center justify-between border-t border-border bg-bg-secondary px-4 py-1.5">
        <p className="truncate font-mono text-[10px] text-text-muted">
          {workingDir ? workingDir : "No project"}
        </p>
        {isActive && (
          <p className="shrink-0 font-mono text-[10px] text-text-muted">
            <kbd className="rounded bg-bg-tertiary px-1 py-0.5 text-text-secondary">
              Ctrl+C
            </kbd>{" "}
            to interrupt
          </p>
        )}
      </div>

      {/* Resize handle */}
      <div
        className={`absolute right-0 top-0 h-full w-1 cursor-ew-resize transition-colors hover:bg-primary/50 ${
          isResizing ? "bg-primary" : "bg-transparent"
        }`}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
}
