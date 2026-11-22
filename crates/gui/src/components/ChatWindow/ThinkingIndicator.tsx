import { useState } from "react";
import type { ThinkingIndicatorStyle } from "../../stores/uiStore";
import { ThinkingLine } from "../ThinkingLine";
import {
  selectFuturisticCompactingPhrase,
  selectFuturisticThinkingPhrase,
} from "./thinkingPhrases";

const THINKING_LABEL = "Thinking...";
const COMPACTING_LABEL = "Compacting conversation…";

/**
 * Thinking indicator shown while waiting for the assistant to respond: the
 * shader thinking line for the chosen style (each style is a line variant).
 */
export function ThinkingIndicator({
  label = THINKING_LABEL,
  style = "shimmer",
  compact = false,
}: {
  label?: string;
  style?: ThinkingIndicatorStyle;
  /** Render only the visual indicator for compact status surfaces. */
  compact?: boolean;
}) {
  // The component is mounted for one waiting turn and unmounted when that
  // turn ends. Keeping the phrase in state prevents re-renders from causing
  // repeated, rapid screen-reader announcements.
  const [thinkingPhrase] = useState(selectFuturisticThinkingPhrase);
  const [compactingPhrase] = useState(selectFuturisticCompactingPhrase);
  const isCompacting = label === COMPACTING_LABEL;
  // the expressive styles narrate with the sci-fi phrases; shimmer stays plain
  const usesPhrases = style !== "shimmer";
  const statusLabel = !usesPhrases
    ? label
    : label === THINKING_LABEL
      ? thinkingPhrase
      : isCompacting
        ? compactingPhrase
        : label;

  return (
    <div
      className={compact ? "thinking-indicator--compact" : "flex w-full"}
      data-testid="thinking-indicator"
      data-style={style}
      data-compact={compact || undefined}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={statusLabel}
    >
      <ThinkingLine
        variant={style}
        mode={isCompacting ? "compacting" : "thinking"}
        // compact badges are too small for text: shimmer shows only its
        // hairline there, the expressive lines keep their texture
        text={compact && style === "shimmer" ? "" : statusLabel}
        fallback={compact ? "hairline" : "text"}
        style={compact ? { width: 40, height: 10 } : { height: 20 }}
      />
    </div>
  );
}
