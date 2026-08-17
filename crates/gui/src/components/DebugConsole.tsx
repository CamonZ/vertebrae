import { memo, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { commands } from "../bindings";
import { useDebugStore } from "../stores/debugStore";
import type { DebugTraceEntry, LogEntry } from "../stores/debugStore";
import { formatDebugLogMessage } from "../utils/debugLog";

const MAX_RENDERED_LOGS = 200;
const MAX_RENDERED_TRACES = 200;

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

function useAutoScroll(itemCount: number) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (firstRender.current || distanceFromBottom <= 80) {
      element.scrollTop = element.scrollHeight;
    }
    firstRender.current = false;
  }, [itemCount]);

  return scrollRef;
}

const LogRow = memo(function LogRow({ entry }: { entry: LogEntry }) {
  return (
    <div className="flex gap-2 leading-5">
      <span className="shrink-0 text-gray-500">
        {formatTime(entry.timestamp)}
      </span>
      <span
        className={`w-12 shrink-0 text-right ${levelColors[entry.level] ?? "text-gray-400"}`}
      >
        {entry.level}
      </span>
      <span className="shrink-0 text-cyan-300">[{entry.crateName}]</span>
      <span className="min-w-0 break-all">
        {formatDebugLogMessage(entry.message)}
      </span>
    </div>
  );
});

const TraceRow = memo(function TraceRow({ entry }: { entry: DebugTraceEntry }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-gray-900 py-1 last:border-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full cursor-pointer gap-2 text-left leading-5"
      >
        <span className="shrink-0 text-gray-600">
          {formatTime(entry.timestamp)}
        </span>
        <span className="shrink-0 text-cyan-300">{entry.source}</span>
        <span className="shrink-0 text-blue-300">{entry.kind}</span>
        <span className="shrink-0 text-amber-300">
          {entry.direction ?? "internal"}
        </span>
        <span className="min-w-0 truncate text-gray-500">
          {entry.backendSessionId ?? entry.sessionId ?? ""}
          {entry.turnId ? ` · ${entry.turnId}` : ""}
          {entry.state ? ` · ${entry.state}` : ""}
        </span>
      </button>
      {expanded && entry.detail && (
        <div className="pl-2 text-yellow-300">{entry.detail}</div>
      )}
      {expanded && entry.payload && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all pl-2 text-gray-400">
          {entry.payload}
        </pre>
      )}
    </div>
  );
});

const LogsPanel = memo(function LogsPanel() {
  const logs = useDebugStore((state) => state.logs);
  const [logFilter, setLogFilter] = useState("");
  const [logCrateFilter, setLogCrateFilter] = useState("all");
  const scrollRef = useAutoScroll(logs.length);

  const logCrates = useMemo(
    () => [...new Set(logs.map((entry) => entry.crateName))].sort(),
    [logs]
  );

  const filteredLogs = useMemo(() => {
    const filter = logFilter.trim().toLowerCase();
    return logs.filter((entry) => {
      if (logCrateFilter !== "all" && entry.crateName !== logCrateFilter) {
        return false;
      }
      return (
        !filter ||
        `${entry.crateName} ${entry.target ?? ""} ${entry.level} ${entry.message}`
          .toLowerCase()
          .includes(filter)
      );
    });
  }, [logCrateFilter, logFilter, logs]);

  const visibleLogs = filteredLogs.slice(-MAX_RENDERED_LOGS);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-800 px-3 py-1.5">
        <select
          value={logCrateFilter}
          onChange={(event) => setLogCrateFilter(event.target.value)}
          className="rounded border border-gray-800 bg-gray-900 px-2 py-1 text-gray-300 outline-none"
          aria-label="Filter logs by crate"
        >
          <option value="all">All crates</option>
          {logCrates.map((crateName) => (
            <option key={crateName} value={crateName}>
              {crateName}
            </option>
          ))}
        </select>
        <input
          value={logFilter}
          onChange={(event) => setLogFilter(event.target.value)}
          placeholder="Filter logs"
          className="min-w-0 flex-1 rounded border border-gray-800 bg-gray-900 px-2 py-1 text-gray-300 outline-none placeholder:text-gray-600"
          aria-label="Filter logs"
        />
        <span className="shrink-0 text-gray-600">
          {filteredLogs.length}/{logs.length}
        </span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
        {filteredLogs.length > visibleLogs.length && (
          <div className="py-1 text-gray-600">
            Showing the newest {MAX_RENDERED_LOGS} matching logs.
          </div>
        )}
        {visibleLogs.map((entry, index) => (
          <LogRow key={`${entry.timestamp}-${index}`} entry={entry} />
        ))}
      </div>
    </div>
  );
});

const HarnessPanel = memo(function HarnessPanel() {
  const traces = useDebugStore((state) => state.traces);
  const [traceFilter, setTraceFilter] = useState("");
  const scrollRef = useAutoScroll(traces.length);

  const filteredTraces = useMemo(() => {
    const filter = traceFilter.trim().toLowerCase();
    if (!filter) return traces;
    return traces.filter((entry) =>
      [
        entry.source,
        entry.kind,
        entry.direction,
        entry.sessionId,
        entry.backendSessionId,
        entry.turnId,
        entry.state,
        entry.detail,
        entry.payload,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(filter)
    );
  }, [traceFilter, traces]);

  const harnessStates = useMemo(() => {
    const states = new Map<
      string,
      { id: string; state: string; last: DebugTraceEntry }
    >();
    for (const trace of traces) {
      const id = trace.backendSessionId ?? trace.sessionId;
      if (!id) continue;
      const existing = states.get(id);
      states.set(id, {
        id,
        state: trace.state ?? existing?.state ?? "observed",
        last: trace,
      });
    }
    return [...states.values()].reverse();
  }, [traces]);

  const visibleTraces = filteredTraces.slice(-MAX_RENDERED_TRACES);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <div className="flex shrink-0 items-center gap-2 text-[10px] text-gray-500">
        <span className="rounded border border-amber-900/60 px-2 py-1 text-amber-300">
          In-memory diagnostic trace; raw payloads may contain prompt data.
        </span>
        <input
          value={traceFilter}
          onChange={(event) => setTraceFilter(event.target.value)}
          placeholder="Filter session, turn, event, or payload"
          className="min-w-0 flex-1 rounded border border-gray-800 bg-gray-900 px-2 py-1 text-gray-300 outline-none placeholder:text-gray-600"
        />
      </div>

      <div className="flex shrink-0 gap-2 overflow-x-auto">
        {harnessStates.length === 0 ? (
          <span className="text-gray-600">No local harness activity yet.</span>
        ) : (
          harnessStates.map(({ id, state, last }) => (
            <div
              key={id}
              className="min-w-56 rounded border border-gray-800 bg-gray-900 px-2 py-1"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-gray-200">{id}</span>
                <span className="text-cyan-300">{state}</span>
              </div>
              <div className="truncate text-[10px] text-gray-500">
                {last.source} · {last.kind} · {last.direction ?? "internal"}
              </div>
            </div>
          ))
        )}
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto rounded border border-gray-800 bg-gray-925 px-2 py-1"
      >
        {filteredTraces.length > visibleTraces.length && (
          <div className="py-1 text-gray-600">
            Showing the newest {MAX_RENDERED_TRACES} matching traces.
          </div>
        )}
        {visibleTraces.map((entry) => (
          <TraceRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
});

async function exportDebugData(): Promise<string | null> {
  const { logs, traces } = useDebugStore.getState();
  const exportData = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    logs,
    traces,
  };
  const contents = JSON.stringify(exportData, null, 2);
  const filename = `vertebrae-debug-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`;

  try {
    const acceptancePath = import.meta.env.DEV
      ? (
          window as Window & {
            __VERTEBRAE_ACCEPTANCE_EXPORT_PATH__?: string;
          }
        ).__VERTEBRAE_ACCEPTANCE_EXPORT_PATH__
      : undefined;
    const path =
      acceptancePath ??
      (await save({
        defaultPath: filename,
        filters: [{ name: "JSON", extensions: ["json"] }],
        title: "Export diagnostic console JSON",
      }));
    if (!path) return null;

    const result = await commands.writeDebugExport(path, contents);
    return result.status === "error" ? result.error.message : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function DebugConsolePanel() {
  const logsCount = useDebugStore((state) => state.logs.length);
  const tracesCount = useDebugStore((state) => state.traces.length);
  const clearLogs = useDebugStore((state) => state.clearLogs);
  const toggleDebugPanel = useDebugStore((state) => state.toggleDebugPanel);
  const [tab, setTab] = useState<"logs" | "harness">("logs");
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleExport = async () => {
    setIsExporting(true);
    setExportError(null);
    const error = await exportDebugData();
    setExportError(error);
    setIsExporting(false);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex h-[28rem] flex-col border-t border-gray-700 bg-gray-950 font-mono text-xs text-gray-300">
      <div className="flex shrink-0 items-center justify-between border-b border-gray-800 px-3 py-1.5">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-gray-100">Debug Console</span>
          <button
            onClick={() => setTab("logs")}
            className={`rounded px-2 py-0.5 ${tab === "logs" ? "bg-gray-700 text-gray-100" : "text-gray-500 hover:text-gray-300"}`}
          >
            Logs ({logsCount})
          </button>
          <button
            onClick={() => setTab("harness")}
            className={`rounded px-2 py-0.5 ${tab === "harness" ? "bg-gray-700 text-gray-100" : "text-gray-500 hover:text-gray-300"}`}
          >
            Local harness ({tracesCount})
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => void handleExport()}
            disabled={isExporting}
            data-testid="debug-console-export"
            className="rounded px-2 py-0.5 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            title="Export retained logs and local harness traces as JSON"
          >
            {isExporting ? "Exporting…" : "Export JSON"}
          </button>
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

      {exportError && (
        <div
          role="alert"
          className="shrink-0 border-b border-red-900 px-3 py-1 text-red-300"
        >
          Export failed: {exportError}
        </div>
      )}

      {tab === "logs" ? <LogsPanel /> : <HarnessPanel />}
    </div>
  );
}

export function DebugConsole() {
  const debugPanelOpen = useDebugStore((state) => state.debugPanelOpen);
  if (!debugPanelOpen) return null;
  return <DebugConsolePanel />;
}
