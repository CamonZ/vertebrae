import { useState } from "react";
import type { ThinkingIndicatorStyle } from "../../stores/uiStore";
import { selectFuturisticThinkingPhrase } from "./thinkingPhrases";

const MATRIX_COLUMNS = 4;
const MATRIX_ROWS = 6;
const MATRIX_LIGHT_COUNT = MATRIX_COLUMNS * MATRIX_ROWS;
const MATRIX_LIGHT_TONES = [
  "orange",
  "purple",
  "red",
  "gray-dark",
  "gray",
  "gray-light",
  "gray-bright",
] as const;

/** Thinking indicator shown while waiting for the assistant to respond. */
export function ThinkingIndicator({
  label = "Thinking...",
  style = "classic",
}: {
  label?: string;
  style?: ThinkingIndicatorStyle;
}) {
  // The component is mounted for one waiting turn and unmounted when that
  // turn ends. Keeping the phrase in state prevents re-renders from causing
  // repeated, rapid screen-reader announcements.
  const [futuristicPhrase] = useState(selectFuturisticThinkingPhrase);
  const showFuturisticPhrase =
    style === "futuristic" && label === "Thinking...";
  const statusLabel = showFuturisticPhrase ? futuristicPhrase : label;

  return (
    <div
      className="flex justify-start"
      data-testid="thinking-indicator"
      data-style={style}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={statusLabel}
    >
      <div className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-2)] pl-2 pr-4 py-2">
        {style === "futuristic" ? (
          <div
            className="thinking-matrix grid shrink-0 grid-cols-4"
            data-testid="thinking-matrix"
            aria-hidden="true"
          >
            {Array.from({ length: MATRIX_LIGHT_COUNT }, (_, index) => {
              const tone =
                MATRIX_LIGHT_TONES[index % MATRIX_LIGHT_TONES.length];

              return (
                <span
                  className={`thinking-matrix__light thinking-matrix__light--${tone} h-[5px] w-[5px] rounded-[1px] motion-reduce:animate-none`}
                  key={index}
                  style={{
                    animationDelay: `${-((index % MATRIX_COLUMNS) * 0.14 + Math.floor(index / MATRIX_COLUMNS) * 0.06)}s`,
                  }}
                />
              );
            })}
          </div>
        ) : (
          <div
            className="flex gap-1"
            data-testid="thinking-dots"
            aria-hidden="true"
          >
            <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--color-accent)] motion-reduce:animate-none [animation-delay:-0.3s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--color-accent)] motion-reduce:animate-none [animation-delay:-0.15s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--color-accent)] motion-reduce:animate-none" />
          </div>
        )}
        <span className="text-sm text-[var(--color-fg-mute)]">
          {statusLabel}
        </span>
      </div>
    </div>
  );
}
