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
  AssistantMessageEvent,
  ConversationEvent,
  FileEditEvent,
  ThinkingEvent,
  TodoListEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "../../../types/conversation";
import { MarkdownContent } from "../../shared/MarkdownContent";
import { ToolCallBlock } from "../../molecules/ToolCallBlock";
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
      className="text-xs text-fg-mute hover:text-accent font-mono cursor-pointer flex-shrink-0 transition-colors"
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

/**
 * Standalone tool_call renderer used when a tool call appears without an
 * owning assistant turn (orphan tool calls). The bubble grouper in
 * UnifiedChatView nests paired tool calls INSIDE their owning agent bubble
 * using molecules/ToolCallBlock; this fallback path uses the same molecule
 * so the visual story is identical across both paths.
 */
export function ToolCall({
  event,
}: {
  event: ToolCallEvent;
  previousTimestamp: string | null;
}) {
  return (
    <ToolCallBlock
      toolName={event.displayName}
      summary={event.summary}
      state="pending"
      input={JSON.stringify(event.input, null, 2)}
    />
  );
}

/**
 * Final assistant text from Codex `agent_message`. Visually distinct from
 * `ThinkingBlock` (chain-of-thought) so users can scan for the actual reply
 * vs. the model's reasoning.
 */
export function AssistantMessageBlock({
  event,
  previousTimestamp,
}: {
  event: AssistantMessageEvent;
  previousTimestamp: string | null;
}) {
  return (
    <div
      data-testid="assistant-message"
      className="py-2 border-l-2 border-accent/40 pl-3"
    >
      <div className="flex items-start gap-2">
        <span className="font-mono text-2xs uppercase tracking-wider text-accent mt-1">
          assistant
        </span>
        <div className="flex-1 min-w-0">
          <MarkdownContent text={event.text} />
        </div>
        <Timestamp
          timestamp={event.timestamp}
          previousTimestamp={previousTimestamp}
        />
      </div>
    </div>
  );
}

/**
 * Diff-style render for a Codex `file_change` item. Lists each affected
 * file path with its change kind (add/delete/update); the unified diff
 * body is shown collapsed by default and expandable via per-file toggle.
 *
 * The patch status (`completed` / `failed`) tints the header so failed
 * patches are visually distinct.
 */
export function FileEditBlock({
  event,
  previousTimestamp,
}: {
  event: FileEditEvent;
  previousTimestamp: string | null;
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const failed = event.status === "failed";
  return (
    <div
      data-testid="file-edit"
      data-status={event.status}
      className="py-2"
    >
      <div className="flex items-start gap-2">
        <span
          className={`font-mono text-2xs uppercase tracking-wider mt-1 ${failed ? "text-err" : "text-ok"}`}
        >
          {failed ? "patch failed" : "patch"}
        </span>
        <div className="flex-1 min-w-0">
          {event.changes.map((change, idx) => {
            const isOpen = openIdx === idx;
            const hasDiff = typeof change.diff === "string" && change.diff.length > 0;
            return (
              <div key={`${change.path}-${idx}`} className="text-sm">
                <button
                  type="button"
                  className="flex items-center gap-2 w-full text-left py-0.5"
                  onClick={() => setOpenIdx(isOpen ? null : idx)}
                  disabled={!hasDiff}
                >
                  <span
                    className={`font-mono text-2xs uppercase tracking-wider ${changeKindClass(change.kind)}`}
                  >
                    {change.kind}
                  </span>
                  <span className="font-mono text-xs text-fg truncate">
                    {change.path}
                  </span>
                  {hasDiff && (
                    <span
                      className={`text-fg-mute transition-transform ${isOpen ? "rotate-90" : ""}`}
                    >
                      <ChevronRightIcon />
                    </span>
                  )}
                </button>
                {isOpen && hasDiff && (
                  <pre className="mt-1 ml-4 p-2 bg-bg-2 rounded text-xs font-mono whitespace-pre-wrap break-words">
                    {renderDiffLines(change.diff!)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
        <Timestamp
          timestamp={event.timestamp}
          previousTimestamp={previousTimestamp}
        />
      </div>
    </div>
  );
}

function changeKindClass(kind: string): string {
  switch (kind) {
    case "add":
      return "text-ok";
    case "delete":
      return "text-err";
    case "update":
      return "text-warn";
    default:
      return "text-fg-mute";
  }
}

/**
 * Render a unified diff body with per-line +/- coloring. Recognized line
 * leads:
 *   `+` -> addition (text-ok)
 *   `-` -> deletion (text-err)
 *   `@@` -> hunk header (text-info)
 * everything else renders neutral.
 */
function renderDiffLines(diff: string): ReactNode {
  return diff.split("\n").map((line, i) => {
    let cls = "text-fg-soft";
    if (line.startsWith("+++") || line.startsWith("---")) {
      cls = "text-fg-mute";
    } else if (line.startsWith("@@")) {
      cls = "text-info";
    } else if (line.startsWith("+")) {
      cls = "text-ok";
    } else if (line.startsWith("-")) {
      cls = "text-err";
    }
    return (
      <div key={i} className={cls}>
        {line || " "}
      </div>
    );
  });
}

/**
 * Render a Codex `todo_list` plan as a checklist. Each row is a checkbox
 * (read-only) plus the row text; completed items are struck through.
 */
export function TodoListBlock({
  event,
  previousTimestamp,
}: {
  event: TodoListEvent;
  previousTimestamp: string | null;
}) {
  return (
    <div data-testid="todo-list" data-item-id={event.itemId} className="py-2">
      <div className="flex items-start gap-2">
        <span className="font-mono text-2xs uppercase tracking-wider text-accent mt-1">
          plan
        </span>
        <ul className="flex-1 min-w-0 space-y-0.5">
          {event.items.map((row, i) => (
            <li
              key={`${i}-${row.text}`}
              className="flex items-start gap-2 text-sm"
              data-completed={row.completed}
            >
              <span
                className={`mt-0.5 flex-shrink-0 ${row.completed ? "text-ok" : "text-fg-mute"}`}
                aria-hidden="true"
              >
                {row.completed ? "[x]" : "[ ]"}
              </span>
              <span
                className={
                  row.completed
                    ? "text-fg-mute line-through"
                    : "text-fg"
                }
              >
                {row.text}
              </span>
            </li>
          ))}
        </ul>
        <Timestamp
          timestamp={event.timestamp}
          previousTimestamp={previousTimestamp}
        />
      </div>
    </div>
  );
}

export function ToolResult({ event }: { event: ToolResultEvent }) {
  return (
    <div className="py-1 ml-8 flex items-start gap-2">
      <EventGlyph
        event={event}
        tintClassName={event.isError ? "text-err" : "text-ok"}
        className="mt-0.5"
      />
      <span
        className={`text-xs whitespace-pre-wrap break-words ${event.isError ? "text-err" : "text-fg-mute"}`}
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
    case "assistant_message":
      return (
        <AssistantMessageBlock
          event={event}
          previousTimestamp={previousTimestamp}
        />
      );
    case "tool_call":
      return <ToolCall event={event} previousTimestamp={previousTimestamp} />;
    case "tool_result":
      return <ToolResult event={event} />;
    case "file_edit":
      return (
        <FileEditBlock event={event} previousTimestamp={previousTimestamp} />
      );
    case "todo_list":
      return (
        <TodoListBlock event={event} previousTimestamp={previousTimestamp} />
      );
    default:
      return null;
  }
}
