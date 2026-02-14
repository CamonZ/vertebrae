import { useEffect, useRef } from "react";
import { useDebugStore } from "../stores/debugStore";

const levelColors: Record<string, string> = {
  ERROR: "text-red-400",
  WARN: "text-yellow-400",
  INFO: "text-blue-400",
  DEBUG: "text-gray-400",
  TRACE: "text-gray-500",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function DebugConsole() {
  const { logs, debugPanelOpen, clearLogs, toggleDebugPanel } = useDebugStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  if (!debugPanelOpen) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex h-72 flex-col border-t border-gray-700 bg-gray-950 font-mono text-xs text-gray-300">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-gray-800 px-3 py-1.5">
        <span className="font-semibold text-gray-100">Debug Console</span>
        <div className="flex gap-2">
          <button
            onClick={clearLogs}
            className="rounded px-2 py-0.5 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          >
            Clear
          </button>
          <button
            onClick={toggleDebugPanel}
            className="rounded px-2 py-0.5 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          >
            Close
          </button>
        </div>
      </div>

      {/* Log output */}
      <div className="flex-1 overflow-y-auto px-3 py-1">
        {logs.map((entry, i) => (
          <div key={i} className="flex gap-2 leading-5">
            <span className="shrink-0 text-gray-500">
              {formatTime(entry.timestamp)}
            </span>
            <span
              className={`w-12 shrink-0 text-right ${levelColors[entry.level] ?? "text-gray-400"}`}
            >
              {entry.level}
            </span>
            <span className="min-w-0 break-all">{entry.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
