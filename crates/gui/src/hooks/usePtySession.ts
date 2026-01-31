import { useCallback, useEffect, useRef, useState } from "react";
import { commands, events, type PtyOutputEvent, type PtyExitEvent } from "../bindings";
import type { TerminalDimensions } from "../components/Terminal/Terminal";

/**
 * Session state for PTY session management
 */
export type PtySessionState = "idle" | "starting" | "running" | "ended" | "error";

/**
 * Options for creating a PTY session
 */
export interface PtySessionOptions {
  /** Working directory for the Claude process */
  workingDir?: string;
  /** Callback when PTY output is received (base64 encoded) */
  onOutput?: (data: string) => void;
  /** Callback when PTY session exits */
  onExit?: (exitCode: number | null, error: string | null) => void;
}

/**
 * Hook to manage a PTY session for Claude CLI interaction
 *
 * Handles session lifecycle, input/output, and resize operations.
 * Automatically cleans up session when component unmounts.
 */
export function usePtySession(options: PtySessionOptions = {}) {
  const { workingDir, onOutput, onExit } = options;

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<PtySessionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

  // Store callbacks in refs to avoid re-subscribing on every render
  const onOutputRef = useRef(onOutput);
  const onExitRef = useRef(onExit);
  onOutputRef.current = onOutput;
  onExitRef.current = onExit;

  // Track the current session ID for cleanup
  const sessionIdRef = useRef<string | null>(null);

  // Generate unique session ID
  const generateSessionId = useCallback(() => {
    return `chat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }, []);

  /**
   * Create a new PTY session
   */
  const createSession = useCallback(
    async (dimensions: TerminalDimensions) => {
      if (state === "running" || state === "starting") {
        return; // Already have an active session
      }

      const newSessionId = generateSessionId();
      setState("starting");
      setError(null);
      setExitCode(null);

      const result = await commands.createPtySession(
        newSessionId,
        dimensions.cols,
        dimensions.rows,
        workingDir ?? null
      );

      if (result.status === "error") {
        const errorMsg =
          "SpawnFailed" in result.error
            ? result.error.SpawnFailed
            : "SessionNotFound" in result.error
              ? result.error.SessionNotFound
              : "WriteFailed" in result.error
                ? result.error.WriteFailed
                : "ResizeFailed" in result.error
                  ? result.error.ResizeFailed
                  : "Unknown error";
        setState("error");
        setError(errorMsg);
        return;
      }

      setSessionId(newSessionId);
      sessionIdRef.current = newSessionId;
      setState("running");
    },
    [state, generateSessionId, workingDir]
  );

  /**
   * Write data to the PTY session
   * Data should be the raw string from terminal onData callback
   */
  const writeToSession = useCallback(
    async (data: string) => {
      if (!sessionId || state !== "running") {
        return;
      }

      // Encode as base64
      const encoded = btoa(data);
      const result = await commands.writePty(sessionId, encoded);

      if (result.status === "error") {
        console.error("Failed to write to PTY:", result.error);
      }
    },
    [sessionId, state]
  );

  /**
   * Resize the PTY session
   */
  const resizeSession = useCallback(
    async (dimensions: TerminalDimensions) => {
      if (!sessionId || state !== "running") {
        return;
      }

      const result = await commands.resizePty(
        sessionId,
        dimensions.cols,
        dimensions.rows
      );

      if (result.status === "error") {
        console.error("Failed to resize PTY:", result.error);
      }
    },
    [sessionId, state]
  );

  /**
   * Close the PTY session
   */
  const closeSession = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    const result = await commands.closePtySession(sessionId);

    if (result.status === "error") {
      console.error("Failed to close PTY session:", result.error);
    }

    // State will be updated by the exit event listener
  }, [sessionId]);

  // Subscribe to PTY events
  useEffect(() => {
    let outputUnlisten: (() => void) | null = null;
    let exitUnlisten: (() => void) | null = null;
    let isCancelled = false;

    const setupListeners = async () => {
      // Listen for PTY output events
      const outputUn = await events.ptyOutputEvent.listen(
        (event: { payload: PtyOutputEvent }) => {
          const { session_id, data } = event.payload;
          if (session_id === sessionIdRef.current) {
            onOutputRef.current?.(data);
          }
        }
      );

      // If component unmounted while we were setting up, clean up immediately
      if (isCancelled) {
        outputUn();
        return;
      }
      outputUnlisten = outputUn;

      // Listen for PTY exit events
      const exitUn = await events.ptyExitEvent.listen(
        (event: { payload: PtyExitEvent }) => {
          const { session_id, exit_code, error } = event.payload;
          if (session_id === sessionIdRef.current) {
            setState("ended");
            setExitCode(exit_code);
            if (error) {
              setError(error);
            }
            onExitRef.current?.(exit_code, error ?? null);
          }
        }
      );

      // If component unmounted while we were setting up, clean up immediately
      if (isCancelled) {
        exitUn();
        outputUnlisten?.();
        return;
      }
      exitUnlisten = exitUn;
    };

    setupListeners();

    return () => {
      isCancelled = true;
      outputUnlisten?.();
      exitUnlisten?.();
    };
  }, []);

  // Cleanup session on unmount
  useEffect(() => {
    return () => {
      if (sessionIdRef.current) {
        // Fire and forget cleanup
        commands.closePtySession(sessionIdRef.current);
      }
    };
  }, []);

  return {
    /** Current session ID */
    sessionId,
    /** Current session state */
    state,
    /** Error message if any */
    error,
    /** Exit code if session ended */
    exitCode,
    /** Create a new PTY session */
    createSession,
    /** Write data to the session */
    writeToSession,
    /** Resize the session */
    resizeSession,
    /** Close the session */
    closeSession,
    /** Whether the session is active */
    isActive: state === "running",
    /** Whether the session has ended */
    hasEnded: state === "ended",
  };
}
