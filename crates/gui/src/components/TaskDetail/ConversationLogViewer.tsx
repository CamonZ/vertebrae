/**
 * ConversationLogViewer - Displays Claude session logs as a conversation timeline.
 *
 * Transforms raw SessionLog entries into a readable conversation view showing:
 * - Session boundaries (start/end with model info, duration, cost)
 * - Agent thinking (collapsible text blocks)
 * - Tool calls with icons and summaries
 * - Tool results (success/error)
 */

import { useState, useMemo, createContext, useContext } from "react";
import type { SessionLog } from "../../bindings";
import {
  parseSessionLogs,
  type ConversationEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type ThinkingEvent,
  type SessionStartEvent,
  type SessionEndEvent,
} from "../../types";

interface ConversationLogViewerProps {
  logs: SessionLog[];
  /** Maximum events to show initially */
  initialLimit?: number;
}

/** Time display mode */
type TimeMode = "absolute" | "differential";

/** Context for sharing time mode across components */
const TimeModeContext = createContext<{
  mode: TimeMode;
  toggle: () => void;
}>({
  mode: "absolute",
  toggle: () => {},
});

/** Format duration in human-readable form */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

/** Format timestamp to time with milliseconds */
function formatTimeWithMs(isoString: string): string {
  try {
    const date = new Date(isoString);
    const time = date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const ms = date.getMilliseconds().toString().padStart(3, "0");
    return `${time}.${ms}`;
  } catch {
    return isoString.slice(11, 23);
  }
}

/** Format differential time (time gap from previous displayed event) */
function formatDifferential(currentTs: string, previousTs: string | null): string {
  if (!previousTs) return "0ms before";

  try {
    const current = new Date(currentTs).getTime();
    const previous = new Date(previousTs).getTime();
    // Use absolute difference since events may be sorted newest-first
    const diffMs = Math.abs(current - previous);

    if (diffMs < 1000) return `${diffMs}ms before`;
    if (diffMs < 60000) return `${(diffMs / 1000).toFixed(1)}s before`;
    if (diffMs < 3600000) {
      const mins = Math.floor(diffMs / 60000);
      const secs = Math.round((diffMs % 60000) / 1000);
      return `${mins}m ${secs}s before`;
    }
    const hours = Math.floor(diffMs / 3600000);
    const mins = Math.round((diffMs % 3600000) / 60000);
    return `${hours}h ${mins}m before`;
  } catch {
    return "? before";
  }
}

/** Clickable timestamp component that toggles between absolute and differential */
function Timestamp({
  timestamp,
  previousTimestamp
}: {
  timestamp: string;
  previousTimestamp: string | null;
}) {
  const { mode, toggle } = useContext(TimeModeContext);

  const displayTime = mode === "absolute"
    ? formatTimeWithMs(timestamp)
    : formatDifferential(timestamp, previousTimestamp);

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
          toggle();
        }
      }}
      className="text-xs text-text-muted hover:text-primary font-mono cursor-pointer flex-shrink-0 transition-colors"
      title={mode === "absolute" ? "Click for differential time" : "Click for absolute time"}
    >
      {displayTime}
    </span>
  );
}

// Inline SVG icons
const Icons = {
  cpu: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3v2m6-2v2M9 19v2m6-2v2M3 9h2m-2 6h2m14-6h2m-2 6h2M7 7h10v10H7z" />
    </svg>
  ),
  check: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  ),
  checkSmall: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  ),
  x: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
  clock: (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  message: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  ),
  chevronRight: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  ),
  terminal: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  ),
  file: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
  search: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  ),
  folder: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  ),
  edit: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  ),
  globe: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" />
    </svg>
  ),
  wrench: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
};

/** Get icon for a tool */
function getToolIcon(toolName: string): React.ReactNode {
  if (toolName === "Bash") return Icons.terminal;
  if (toolName === "Read") return Icons.file;
  if (toolName === "Grep" || toolName.includes("search") || toolName.includes("warpgrep"))
    return Icons.search;
  if (toolName === "Glob") return Icons.folder;
  if (toolName === "Edit" || toolName.includes("edit")) return Icons.edit;
  if (toolName === "Write") return Icons.file;
  if (toolName === "WebFetch" || toolName === "WebSearch") return Icons.globe;
  return Icons.wrench;
}

/** Session start card */
function SessionStart({ event, previousTimestamp }: { event: SessionStartEvent; previousTimestamp: string | null }) {
  return (
    <div className="flex items-center gap-3 py-3 px-4 bg-success/10 rounded-lg border border-success/20">
      <span className="text-success">{Icons.cpu}</span>
      <div className="flex-1">
        <div className="text-sm font-medium text-text-primary">Session Started</div>
        <div className="text-xs text-text-muted">Model: {event.model}</div>
      </div>
      <Timestamp timestamp={event.timestamp} previousTimestamp={previousTimestamp} />
    </div>
  );
}

/** Session end card */
function SessionEnd({ event, previousTimestamp }: { event: SessionEndEvent; previousTimestamp: string | null }) {
  return (
    <div className="flex items-center gap-3 py-3 px-4 bg-info/10 rounded-lg border border-info/20">
      <span className="text-info">{Icons.check}</span>
      <div className="flex-1">
        <div className="text-sm font-medium text-text-primary">Session Complete</div>
        <div className="flex gap-4 text-xs text-text-muted">
          <span className="flex items-center gap-1">
            {Icons.clock}
            {formatDuration(event.durationMs)}
          </span>
          <span>{event.numTurns} turns</span>
          {event.costUsd > 0 && <span>${event.costUsd.toFixed(4)}</span>}
        </div>
      </div>
      <Timestamp timestamp={event.timestamp} previousTimestamp={previousTimestamp} />
    </div>
  );
}

/** Collapsible thinking block */
function ThinkingBlock({ event, previousTimestamp }: { event: ThinkingEvent; previousTimestamp: string | null }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isLong = event.text.length > 200;
  const displayText = isExpanded || !isLong ? event.text : event.text.slice(0, 200) + "...";

  return (
    <div className="py-2">
      <div className="flex items-start gap-2">
        <span className="text-text-muted mt-1 flex-shrink-0">{Icons.message}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text-secondary whitespace-pre-wrap break-words">
            {displayText}
          </p>
          {isLong && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-xs text-primary hover:text-primary-hover mt-1"
            >
              {isExpanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
        <Timestamp timestamp={event.timestamp} previousTimestamp={previousTimestamp} />
      </div>
    </div>
  );
}

/** Format a value for display in tool input */
function formatInputValue(value: unknown): React.ReactNode {
  if (value === null) return <span className="text-text-muted">null</span>;
  if (value === undefined) return <span className="text-text-muted">undefined</span>;
  if (typeof value === "boolean") return <span className="text-info">{value.toString()}</span>;
  if (typeof value === "number") return <span className="text-warning">{value}</span>;
  if (typeof value === "string") {
    // Truncate long strings
    const displayValue = value.length > 200 ? value.slice(0, 200) + "..." : value;
    return <span className="text-success break-all">{displayValue}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-text-muted">[]</span>;
    return (
      <span>
        {value.map((item, i) => (
          <div key={i} className="ml-4">
            <span className="text-text-muted">[{i}]</span> {formatInputValue(item)}
          </div>
        ))}
      </span>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-text-muted">{"{}"}</span>;
    return (
      <span>
        {entries.map(([k, v]) => (
          <div key={k} className="ml-4">
            <span className="text-primary">{k}:</span> {formatInputValue(v)}
          </div>
        ))}
      </span>
    );
  }
  return <span>{String(value)}</span>;
}

/** Tool call card */
function ToolCall({ event, previousTimestamp }: { event: ToolCallEvent; previousTimestamp: string | null }) {
  const [showInput, setShowInput] = useState(false);

  return (
    <div className="py-2">
      <button
        type="button"
        className="flex items-center gap-2 w-full text-left group"
        onClick={() => setShowInput(!showInput)}
      >
        <div className="w-6 h-6 rounded bg-bg-tertiary flex items-center justify-center flex-shrink-0">
          <span className="text-primary">{getToolIcon(event.toolName)}</span>
        </div>
        <span className="text-sm font-medium text-text-primary">{event.displayName}</span>
        <span className="text-sm text-text-muted truncate flex-1">{event.summary}</span>
        <span
          className={`text-text-muted transition-transform ${showInput ? "rotate-90" : ""}`}
        >
          {Icons.chevronRight}
        </span>
        <Timestamp timestamp={event.timestamp} previousTimestamp={previousTimestamp} />
      </button>
      {showInput && (
        <div className="mt-2 ml-8 p-3 bg-bg-tertiary rounded text-xs font-mono overflow-x-auto">
          {Object.entries(event.input).map(([key, value]) => (
            <div key={key} className="py-0.5">
              <span className="text-primary font-medium">{key}:</span>{" "}
              {formatInputValue(value)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tool result indicator */
function ToolResult({ event }: { event: ToolResultEvent }) {
  return (
    <div className="py-1 ml-8 flex items-start gap-2">
      <span className={`flex-shrink-0 mt-0.5 ${event.isError ? "text-error" : "text-success"}`}>
        {event.isError ? Icons.x : Icons.checkSmall}
      </span>
      <span
        className={`text-xs ${event.isError ? "text-error" : "text-text-muted"} truncate`}
        title={event.result}
      >
        {event.result.slice(0, 100)}
        {event.result.length > 100 && "..."}
      </span>
    </div>
  );
}

/** Render a single conversation event */
function EventRenderer({
  event,
  previousTimestamp
}: {
  event: ConversationEvent;
  previousTimestamp: string | null;
}) {
  switch (event.kind) {
    case "session_start":
      return <SessionStart event={event} previousTimestamp={previousTimestamp} />;
    case "session_end":
      return <SessionEnd event={event} previousTimestamp={previousTimestamp} />;
    case "thinking":
      return <ThinkingBlock event={event} previousTimestamp={previousTimestamp} />;
    case "tool_call":
      return <ToolCall event={event} previousTimestamp={previousTimestamp} />;
    case "tool_result":
      return <ToolResult event={event} />;
    default:
      return null;
  }
}

export function ConversationLogViewer({
  logs,
  initialLimit = 50,
}: ConversationLogViewerProps) {
  const [limit, setLimit] = useState(initialLimit);
  const [timeMode, setTimeMode] = useState<TimeMode>("absolute");

  // Parse logs into conversation events
  const events = useMemo(() => parseSessionLogs(logs), [logs]);

  // Limit displayed events
  const displayedEvents = events.slice(0, limit);
  const hasMore = events.length > limit;

  const toggleTimeMode = () => {
    setTimeMode((m) => (m === "absolute" ? "differential" : "absolute"));
  };

  if (events.length === 0) {
    return (
      <div className="text-sm text-text-muted text-center py-4">
        No conversation data available
      </div>
    );
  }

  return (
    <TimeModeContext.Provider value={{ mode: timeMode, toggle: toggleTimeMode }}>
      <div className="space-y-1">
        {/* Time mode indicator */}
        <div className="flex justify-end mb-2">
          <span className="text-[10px] text-text-muted">
            Click timestamps to toggle: {timeMode === "absolute" ? "HH:MM:SS.mmm" : "time before"}
          </span>
        </div>
        {displayedEvents.map((event, index) => {
          const previousTimestamp = index > 0 ? displayedEvents[index - 1].timestamp : null;
          return (
            <EventRenderer
              key={`${event.kind}-${event.timestamp}-${index}`}
              event={event}
              previousTimestamp={previousTimestamp}
            />
          );
        })}
        {hasMore && (
          <button
            onClick={() => setLimit((l) => l + 50)}
            className="w-full py-2 text-sm text-primary hover:text-primary-hover text-center"
          >
            Show more ({events.length - limit} remaining)
          </button>
        )}
      </div>
    </TimeModeContext.Provider>
  );
}
