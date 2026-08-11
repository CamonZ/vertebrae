import { useEffect } from "react";
import { attachLogger, LogLevel } from "@tauri-apps/plugin-log";
import { useDebugStore } from "../stores/debugStore";
import { inferDebugCrate, splitDebugLogTarget } from "../utils/debugLog";

const LOCAL_CHAT_TRACE_PREFIX = "[LOCAL_CHAT_TRACE] ";

function parseLocalChatTrace(message: string): Record<string, unknown> | null {
  const marker = message.indexOf(LOCAL_CHAT_TRACE_PREFIX);
  if (marker < 0) return null;
  try {
    const value: unknown = JSON.parse(
      message.slice(marker + LOCAL_CHAT_TRACE_PREFIX.length)
    );
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const levelName: Record<number, string> = {
  [LogLevel.Trace]: "TRACE",
  [LogLevel.Debug]: "DEBUG",
  [LogLevel.Info]: "INFO",
  [LogLevel.Warn]: "WARN",
  [LogLevel.Error]: "ERROR",
};

/**
 * Subscribes to Rust backend logs via tauri-plugin-log's Webview target.
 * Call once at the app root level.
 */
export function useDebugLogger() {
  const addLog = useDebugStore((s) => s.addLog);
  const addTrace = useDebugStore((s) => s.addTrace);

  useEffect(() => {
    let detach: (() => void) | undefined;

    attachLogger(({ level, message }) => {
      const trace = parseLocalChatTrace(message);
      const { target } = splitDebugLogTarget(message);
      addLog({
        timestamp: Date.now(),
        level: levelName[level] ?? "UNKNOWN",
        crateName: inferDebugCrate(message),
        target,
        message,
      });
      if (trace && typeof trace.source === "string" && typeof trace.kind === "string") {
        addTrace({
          source: trace.source,
          kind: trace.kind,
          direction: typeof trace.direction === "string" ? trace.direction : undefined,
          sessionId: typeof trace.session_id === "string" ? trace.session_id : undefined,
          backendSessionId:
            typeof trace.backend_session_id === "string"
              ? trace.backend_session_id
              : undefined,
          turnId: typeof trace.turn_id === "string" ? trace.turn_id : undefined,
          state: typeof trace.state === "string" ? trace.state : undefined,
          detail: typeof trace.detail === "string" ? trace.detail : undefined,
          payload: typeof trace.payload === "string" ? trace.payload : undefined,
          timestamp:
            typeof trace.timestamp_ms === "number"
              ? trace.timestamp_ms
              : Date.now(),
        });
      }
    }).then((fn) => {
      detach = fn;
    });

    return () => {
      detach?.();
    };
  }, [addLog, addTrace]);
}
