import { useState } from "react";
import type { ThinkingIndicatorStyle } from "../../stores/uiStore";
import {
  selectFuturisticCompactingPhrase,
  selectFuturisticThinkingPhrase,
} from "./thinkingPhrases";
import {
  getThinkingRadialBand,
  THINKING_ALMOND_MASK,
  THINKING_MATRIX_COLUMNS,
  THINKING_MATRIX_LIGHT_COUNT,
  THINKING_MAX_RADIAL_BAND,
} from "./thinkingIndicatorGeometry";

const COMPACTING_LABEL = "Compacting conversation…";
const RADIAL_DELAY_SECONDS = 0.12;
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
  const [futuristicCompactingPhrase] = useState(
    selectFuturisticCompactingPhrase
  );
  const showFuturisticPhrase =
    style === "futuristic" && label === "Thinking...";
  const showFuturisticCompactingPhrase =
    style === "futuristic" && label === COMPACTING_LABEL;
  const isCompacting = showFuturisticCompactingPhrase;
  const statusLabel = showFuturisticPhrase
    ? futuristicPhrase
    : showFuturisticCompactingPhrase
      ? futuristicCompactingPhrase
      : label;

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
            className="thinking-matrix grid shrink-0 grid-cols-8 grid-rows-5 gap-px"
            data-testid="thinking-matrix"
            data-shape="wide-almond"
            data-animation-direction={isCompacting ? "inward" : "outward"}
            aria-hidden="true"
          >
            {Array.from({ length: THINKING_MATRIX_LIGHT_COUNT }, (_, index) => {
              const row = Math.floor(index / THINKING_MATRIX_COLUMNS);
              const column = index % THINKING_MATRIX_COLUMNS;
              const radialBand = getThinkingRadialBand(row, column);
              const tone =
                radialBand === 0
                  ? "gray"
                  : MATRIX_LIGHT_TONES[index % MATRIX_LIGHT_TONES.length];
              const animationBand = isCompacting
                ? THINKING_MAX_RADIAL_BAND - radialBand
                : radialBand;
              const isAlmondCell = THINKING_ALMOND_MASK[row][column] === "X";

              return (
                <span
                  className={`thinking-matrix__light thinking-matrix__light--${tone} thinking-matrix__light--${isAlmondCell ? "inside" : "outside"} h-[4px] w-[4px] rounded-full motion-reduce:animate-none`}
                  data-column={column}
                  data-radial-band={radialBand}
                  data-row={row}
                  key={index}
                  style={{
                    animationDelay: `${animationBand * RADIAL_DELAY_SECONDS}s`,
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
