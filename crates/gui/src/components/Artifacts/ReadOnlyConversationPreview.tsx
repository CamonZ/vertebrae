import { useState } from "react";
import type { ConversationEvent } from "../../types/conversation";
import {
  EventRenderer,
  TimeModeContext,
  type TimeMode,
} from "../Traces/conversation/EventRenderer";
import { MarkdownContent } from "../shared/MarkdownContent";

interface ReadOnlyConversationPreviewProps {
  events: ConversationEvent[];
}

/**
 * Conversation presentation for persisted artifacts. It shares the normalized
 * event renderer with traces, but deliberately has no session transport,
 * composer, prompt controls, or mutation callbacks.
 */
export function ReadOnlyConversationPreview({
  events,
}: ReadOnlyConversationPreviewProps) {
  const [timeMode, setTimeMode] = useState<TimeMode>("absolute");

  return (
    <TimeModeContext.Provider
      value={{
        mode: timeMode,
        toggle: () =>
          setTimeMode((current) =>
            current === "absolute" ? "differential" : "absolute"
          ),
      }}
    >
      <div className="space-y-1" data-testid="artifact-conversation-preview">
        <div className="flex justify-end mb-2">
          <span className="text-2xs text-fg-mute">
            Click timestamps to toggle:{" "}
            {timeMode === "absolute" ? "HH:MM:SS.mmm" : "time before"}
          </span>
        </div>
        {events.map((event, index) => {
          const previousTimestamp =
            index > 0 ? events[index - 1].timestamp : null;
          if (event.kind === "user_message") {
            return (
              <div
                key={`user-${event.timestamp}-${index}`}
                data-testid="artifact-user-message"
                className="rounded-md border border-border bg-bg-subtle px-3 py-2"
              >
                <span className="text-2xs uppercase tracking-wider text-fg-mute">
                  user
                </span>
                <MarkdownContent text={event.text} />
              </div>
            );
          }
          return (
            <EventRenderer
              key={`${event.kind}-${event.timestamp}-${index}`}
              event={event}
              previousTimestamp={previousTimestamp}
            />
          );
        })}
      </div>
    </TimeModeContext.Provider>
  );
}
