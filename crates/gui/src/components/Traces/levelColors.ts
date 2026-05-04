/**
 * Shared color tokens for Traces views (FlightStrip + UnifiedChatView).
 *
 * Two palettes live here:
 *
 *   - `levelTintClass(level)` — task-level tint (epic / ticket / task). The
 *     brain glyph in the strip's MAIN lane and the ThinkingBlock in the chat
 *     both tint by the owning task's level so the two views read as one
 *     system.
 *
 *   - `thresholdKindClass(kind)` — per-kind color for threshold markers
 *     (rejection = error, approval = success, neutral otherwise). Shared
 *     between the strip's threshold lane and the chat's StepBoundary /
 *     TransitionMarker / DelegationBlock affordances so the user sees the
 *     same "kind = color" mapping in both places.
 */
import type { ThresholdMarkerKind } from "./timeline";

export const LEVEL_TINT_CLASS: Record<string, string> = {
  epic: "text-info",
  ticket: "text-primary",
  task: "text-text-secondary",
};

export function levelTintClass(level: string | null | undefined): string {
  return level && LEVEL_TINT_CLASS[level]
    ? LEVEL_TINT_CLASS[level]
    : "text-text-secondary";
}

/**
 * Per-kind text-color class for threshold markers and chat boundary
 * affordances. Mirrors the strip's threshold-callout coloring so a rejection
 * reads red in both views, while neutral kinds (transition, retry,
 * model_fallback, execution_start/end) stay text-secondary.
 *
 * Approval is tinted success so the affordance is *visible* (the spec called
 * out "threshold affordance — NOT a blanket gold tint"; per-kind variants
 * coexist with FlightStrip's per-kind callout colors).
 */
export const THRESHOLD_KIND_CLASS: Record<ThresholdMarkerKind, string> = {
  approval: "text-success",
  rejection: "text-error",
  model_fallback: "text-text-secondary",
  transition: "text-text-secondary",
  retry: "text-text-secondary",
  execution_start: "text-text-secondary",
  execution_end: "text-text-secondary",
};

export function thresholdKindClass(
  kind: ThresholdMarkerKind | null | undefined
): string {
  return kind ? THRESHOLD_KIND_CLASS[kind] : "text-text-secondary";
}

/**
 * Border-color class matching `thresholdKindClass`. Used by chat boundary
 * components (StepBoundary / TransitionMarker / DelegationBlock) to tint
 * their left border / chip border when a threshold of that kind applies.
 */
export const THRESHOLD_KIND_BORDER_CLASS: Record<ThresholdMarkerKind, string> =
  {
    approval: "border-success",
    rejection: "border-error",
    model_fallback: "border-primary",
    transition: "border-primary",
    retry: "border-primary",
    execution_start: "border-primary",
    execution_end: "border-primary",
  };

export function thresholdKindBorderClass(
  kind: ThresholdMarkerKind | null | undefined
): string {
  return kind ? THRESHOLD_KIND_BORDER_CLASS[kind] : "border-primary";
}
