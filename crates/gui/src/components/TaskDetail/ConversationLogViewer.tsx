/**
 * ConversationLogViewer - Displays Claude session logs as a conversation timeline.
 *
 * Transforms raw SessionLog entries into a readable conversation view showing:
 * - Session boundaries (start/end with model info, duration, cost)
 * - Agent thinking (collapsible text blocks)
 * - Tool calls with icons and summaries
 * - Tool results (success/error)
 *
 * Rendering primitives are shared with UnifiedChatView via
 * `components/Traces/conversation/EventRenderer`.
 */

import { useState, useMemo } from "react";
import type { SessionLog } from "../../bindings";
import { parseSessionLogs } from "../../types";
import {
  EventRenderer,
  TimeModeContext,
  type TimeMode,
} from "../Traces/conversation/EventRenderer";

interface ConversationLogViewerProps {
  logs: SessionLog[];
  /** Maximum events to show initially */
  initialLimit?: number;
}

export function ConversationLogViewer({
  logs,
  initialLimit = 50,
}: ConversationLogViewerProps) {
  const [limit, setLimit] = useState(initialLimit);
  const [timeMode, setTimeMode] = useState<TimeMode>("absolute");

  const events = useMemo(() => parseSessionLogs(logs), [logs]);
  const displayedEvents = events.slice(0, limit);
  const hasMore = events.length > limit;

  const toggleTimeMode = () => {
    setTimeMode((m) => (m === "absolute" ? "differential" : "absolute"));
  };

  if (events.length === 0) {
    return (
      <div className="text-sm text-fg-mute text-center py-4">
        No conversation data available
      </div>
    );
  }

  return (
    <TimeModeContext.Provider value={{ mode: timeMode, toggle: toggleTimeMode }}>
      <div className="space-y-1">
        <div className="flex justify-end mb-2">
          <span className="text-2xs text-fg-mute">
            Click timestamps to toggle:{" "}
            {timeMode === "absolute" ? "HH:MM:SS.mmm" : "time before"}
          </span>
        </div>
        {displayedEvents.map((event, index) => {
          const previousTimestamp =
            index > 0 ? displayedEvents[index - 1].timestamp : null;
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
            className="w-full py-2 text-sm text-accent hover:text-accent-deep text-center"
          >
            Show more ({events.length - limit} remaining)
          </button>
        )}
      </div>
    </TimeModeContext.Provider>
  );
}
