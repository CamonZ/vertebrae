import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type TerminalHandle, type TerminalDimensions } from "../components/Terminal/Terminal";
import { usePtySession } from "../hooks/usePtySession";
import { commands } from "../bindings";

/**
 * ChatPage provides a terminal interface for interacting with Claude Code.
 *
 * Features:
 * - Spawns a Claude Code PTY session on mount
 * - Streams PTY output to the Terminal component
 * - Sends user input to the PTY
 * - Handles terminal resize
 * - Session controls (new session, clear, close)
 * - Clean PTY cleanup on unmount
 */
export function ChatPage() {
  const terminalRef = useRef<TerminalHandle>(null);
  const [workingDir, setWorkingDir] = useState<string | null>(null);
  const [isLoadingProject, setIsLoadingProject] = useState(true);
  const initialDimensionsRef = useRef<TerminalDimensions | null>(null);

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
      state === "idle" &&
      initialDimensionsRef.current
    ) {
      createSession(initialDimensionsRef.current);
    }
  }, [isLoadingProject, state, createSession]);

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
      const dims = terminalRef.current?.getDimensions() ?? { cols: 80, rows: 24 };
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

  // Focus terminal on mount
  useEffect(() => {
    // Focus after a short delay to ensure terminal is mounted
    const timer = setTimeout(() => {
      terminalRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header with session controls */}
      <div className="relative flex items-center justify-between border-b border-border bg-bg-primary px-6 py-3">
        {/* Neural grid background */}
        <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

        <div className="relative flex items-center gap-4">
          <h1 className="text-lg font-semibold text-text-primary">
            Claude Chat
          </h1>

          {/* Session status indicator */}
          <div className="flex items-center gap-2">
            {state === "starting" && (
              <div className="flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
                <span className="text-xs font-medium text-primary">
                  Starting...
                </span>
              </div>
            )}
            {isActive && (
              <div className="flex items-center gap-2 rounded-full border border-success/30 bg-success/10 px-3 py-1">
                <span className="relative flex h-2 w-2">
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                </span>
                <span className="text-xs font-medium text-success">Active</span>
              </div>
            )}
            {hasEnded && (
              <div className="flex items-center gap-2 rounded-full border border-text-muted/30 bg-bg-secondary px-3 py-1">
                <span className="relative inline-flex h-2 w-2 rounded-full bg-text-muted" />
                <span className="text-xs font-medium text-text-muted">
                  Ended
                </span>
              </div>
            )}
            {state === "error" && (
              <div className="flex items-center gap-2 rounded-full border border-error/30 bg-error/10 px-3 py-1">
                <span className="relative inline-flex h-2 w-2 rounded-full bg-error" />
                <span className="text-xs font-medium text-error">Error</span>
              </div>
            )}
          </div>
        </div>

        {/* Session control buttons */}
        <div className="relative flex items-center gap-2">
          <button
            onClick={handleNewSession}
            className="flex items-center gap-1.5 rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            title="Start new session"
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
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            New
          </button>
          <button
            onClick={handleClear}
            className="flex items-center gap-1.5 rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            title="Clear terminal"
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
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
            Clear
          </button>
          {isActive && (
            <button
              onClick={handleClose}
              className="flex items-center gap-1.5 rounded-md border border-error/30 bg-error/10 px-3 py-1.5 text-xs font-medium text-error transition-colors hover:bg-error/20"
              title="Close session"
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
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
              Close
            </button>
          )}
        </div>
      </div>

      {/* Error message */}
      {error && state === "error" && (
        <div className="border-b border-error/30 bg-error/10 px-6 py-3">
          <p className="text-sm text-error">
            Failed to start session: {error}
          </p>
          <button
            onClick={handleNewSession}
            className="mt-2 text-xs font-medium text-error underline hover:no-underline"
          >
            Try again
          </button>
        </div>
      )}

      {/* Terminal area */}
      <div className="flex-1 overflow-hidden bg-bg-primary p-4">
        <div className="h-full rounded-lg border border-border bg-[#09090b]">
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
      </div>

      {/* Footer with working directory info */}
      <div className="flex items-center justify-between border-t border-border bg-bg-secondary px-6 py-2">
        <p className="font-mono text-xs text-text-muted">
          {workingDir ? (
            <>
              Working directory:{" "}
              <span className="text-text-secondary">{workingDir}</span>
            </>
          ) : (
            "No project selected"
          )}
        </p>
        {isActive && (
          <p className="font-mono text-xs text-text-muted">
            Press <kbd className="rounded bg-bg-tertiary px-1.5 py-0.5 text-text-secondary">Ctrl+C</kbd> to interrupt
          </p>
        )}
      </div>
    </div>
  );
}
