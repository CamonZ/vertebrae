/**
 * Shared event-rendering primitives extracted from ConversationLogViewer
 * so both the legacy per-execution viewer and the new UnifiedChatView
 * can render Claude session-log events identically.
 *
 * Each "kind" of `ConversationEvent` has its own small component. The
 * top-level `EventRenderer` switches on `event.kind` and dispatches.
 *
 * Time mode (absolute vs differential timestamps) is provided through
 * `TimeModeContext` so callers can compose their own toggles around a
 * tree of events without prop drilling.
 */

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type {
  ConversationEvent,
  ThinkingEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "../../../types/conversation";
import { MarkdownContent } from "../../shared/MarkdownContent";
import { EventGlyph } from "../EventGlyph";
import { levelTintClass } from "../levelColors";

// ---------------------------------------------------------------------------
// Time mode
// ---------------------------------------------------------------------------

export type TimeMode = "absolute" | "differential";

export const TimeModeContext = createContext<{
  mode: TimeMode;
  toggle: () => void;
}>({
  mode: "absolute",
  toggle: () => {},
});

export function humanizeStepName(name: string | null | undefined): string {
  if (!name) return "step";
  return name.replace(/_/g, " ");
}

export function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatTimeWithMs(isoString: string): string {
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

/**
 * Format the time delta from `previousTs` to `currentTs` using forward-in-time
 * wording. Events render oldest-to-newest in the chat view, so the delta from
 * event N to event N+1 means how long *after* event N the next one happened.
 *
 * For the very first event there is no previous, so we return an em-dash.
 */
export function formatDifferential(
  currentTs: string,
  previousTs: string | null
): string {
  if (!previousTs) return "—";
  try {
    const current = new Date(currentTs).getTime();
    const previous = new Date(previousTs).getTime();
    const diffMs = Math.abs(current - previous);
    if (diffMs < 1000) return `${diffMs}ms after`;
    if (diffMs < 60000) return `${(diffMs / 1000).toFixed(1)}s after`;
    if (diffMs < 3600000) {
      const mins = Math.floor(diffMs / 60000);
      const secs = Math.round((diffMs % 60000) / 1000);
      return `${mins}m ${secs}s after`;
    }
    const hours = Math.floor(diffMs / 3600000);
    const mins = Math.round((diffMs % 3600000) / 60000);
    return `${hours}h ${mins}m after`;
  } catch {
    return "? after";
  }
}

export function Timestamp({
  timestamp,
  previousTimestamp,
}: {
  timestamp: string;
  previousTimestamp: string | null;
}) {
  const { mode, toggle } = useContext(TimeModeContext);
  const displayTime =
    mode === "absolute"
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
      title={
        mode === "absolute"
          ? "Click for differential time"
          : "Click for absolute time"
      }
    >
      {displayTime}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline icons
// ---------------------------------------------------------------------------
//
// All event iconography routes through `<EventGlyph>` so the chat and the
// flight strip share a single icon source. The only inline SVG remaining is
// the disclosure chevron on `<ToolCall>` — that's a UI affordance, not an
// event glyph, so it doesn't belong in EventGlyph.

function ChevronRightIcon(): ReactNode {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5l7 7-7 7"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sub-components per event kind
// ---------------------------------------------------------------------------
//
// `session_start` / `session_end` events have no inline rendering — their
// facts are folded into the StepBoundary header (see UnifiedChatView's
// `foldOrPush`). The dispatch switch below returns `null` for both kinds.

export function ThinkingBlock({
  event,
  previousTimestamp,
  level = null,
}: {
  event: ThinkingEvent;
  previousTimestamp: string | null;
  /**
   * Owning task's level (epic / ticket / task). When set, the brain glyph
   * shares the same level-tinting story as FlightStrip's MAIN-lane brain
   * glyph so the two views read as one system.
   */
  level?: string | null;
}) {
  return (
    <div className="py-2">
      <div className="flex items-start gap-2">
        <EventGlyph
          event={event}
          tintClassName={levelTintClass(level)}
          className="mt-1"
        />
        <div className="flex-1 min-w-0">
          <MarkdownContent text={event.text} />
        </div>
        <Timestamp timestamp={event.timestamp} previousTimestamp={previousTimestamp} />
      </div>
    </div>
  );
}

function formatInputValue(value: unknown): ReactNode {
  if (value === null) return <span className="text-text-muted">null</span>;
  if (value === undefined) return <span className="text-text-muted">undefined</span>;
  if (typeof value === "boolean") return <span className="text-info">{value.toString()}</span>;
  if (typeof value === "number") return <span className="text-warning">{value}</span>;
  if (typeof value === "string") {
    return <span className="text-success whitespace-pre-wrap break-words">{value}</span>;
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

export function ToolCall({
  event,
  previousTimestamp,
}: {
  event: ToolCallEvent;
  previousTimestamp: string | null;
}) {
  const [showInput, setShowInput] = useState(false);
  return (
    <div className="py-2">
      <button
        type="button"
        className="flex items-start gap-2 w-full text-left group"
        onClick={() => setShowInput(!showInput)}
      >
        <div className="w-6 h-6 rounded bg-bg-tertiary flex items-center justify-center flex-shrink-0">
          <EventGlyph
            event={event}
            tintClassName="text-primary"
            title={event.displayName}
          />
        </div>
        <span className="text-sm font-medium text-text-primary flex-shrink-0">
          {event.displayName}
        </span>
        <span className="text-sm text-text-muted whitespace-pre-wrap break-words flex-1 min-w-0">
          {event.summary}
        </span>
        <span
          className={`text-text-muted transition-transform flex-shrink-0 ${showInput ? "rotate-90" : ""}`}
        >
          <ChevronRightIcon />
        </span>
        <Timestamp timestamp={event.timestamp} previousTimestamp={previousTimestamp} />
      </button>
      {showInput && (
        <div className="mt-2 ml-8 p-3 bg-bg-tertiary rounded text-xs font-mono whitespace-pre-wrap break-words">
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

export function ToolResult({ event }: { event: ToolResultEvent }) {
  return (
    <div className="py-1 ml-8 flex items-start gap-2">
      <EventGlyph
        event={event}
        tintClassName={event.isError ? "text-error" : "text-success"}
        className="mt-0.5"
      />
      <span
        className={`text-xs whitespace-pre-wrap break-words ${event.isError ? "text-error" : "text-text-muted"}`}
      >
        {event.result}
      </span>
    </div>
  );
}

/** Render a single ConversationEvent. */
export function EventRenderer({
  event,
  previousTimestamp,
  level = null,
}: {
  event: ConversationEvent;
  previousTimestamp: string | null;
  /**
   * Owning task's level (epic / ticket / task). Forwarded to ThinkingBlock so
   * the brain glyph in chat shares the level-based tinting used by the strip.
   */
  level?: string | null;
}) {
  switch (event.kind) {
    case "session_start":
    case "session_end":
      // Folded into the StepBoundary header — see file-top note.
      return null;
    case "thinking":
      return (
        <ThinkingBlock
          event={event}
          previousTimestamp={previousTimestamp}
          level={level}
        />
      );
    case "tool_call":
      return <ToolCall event={event} previousTimestamp={previousTimestamp} />;
    case "tool_result":
      return <ToolResult event={event} />;
    default:
      return null;
  }
}
