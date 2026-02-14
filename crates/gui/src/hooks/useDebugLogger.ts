import { useEffect } from "react";
import { attachLogger, LogLevel } from "@tauri-apps/plugin-log";
import { useDebugStore } from "../stores/debugStore";

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

  useEffect(() => {
    let detach: (() => void) | undefined;

    attachLogger(({ level, message }) => {
      addLog({
        timestamp: Date.now(),
        level: levelName[level] ?? "UNKNOWN",
        message,
      });
    }).then((fn) => {
      detach = fn;
    });

    return () => {
      detach?.();
    };
  }, [addLog]);
}
