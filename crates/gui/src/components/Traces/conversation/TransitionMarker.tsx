/**
 * TransitionMarker — inline "from → to" chip between two consecutive step
 * executions on the same task. Visually subtler than StepBoundary because
 * it only signals the transition decision, not a new section header.
 *
 * When a `thresholdKind` is supplied (e.g. the transition coincides with a
 * rejection or approval), the chip's border + text inherit the per-kind tint
 * defined in `levelColors.thresholdKindClass`, sharing the affordance story
 * with FlightStrip's threshold lane.
 */

import type { ReactNode } from "react";
import {
  thresholdKindBorderClass,
  thresholdKindClass,
} from "../levelColors";
import type { ThresholdMarkerKind } from "../timeline";
import { humanizeStepName } from "./EventRenderer";

interface TransitionMarkerProps {
  fromStep: string | null;
  toStep: string | null;
  taskId: string;
  thresholdKind?: ThresholdMarkerKind | null;
}

function clean(name: string | null): string {
  return name ? humanizeStepName(name) : "?";
}

export function TransitionMarker({
  fromStep,
  toStep,
  taskId,
  thresholdKind = null,
}: TransitionMarkerProps): ReactNode {
  const borderClass = thresholdKind
    ? thresholdKindBorderClass(thresholdKind)
    : "border-border";
  const textClass = thresholdKindClass(thresholdKind);
  return (
    <div
      data-testid="unified-chat-transition"
      data-task-id={taskId}
      data-from-step={fromStep ?? ""}
      data-to-step={toStep ?? ""}
      data-threshold-kind={thresholdKind ?? ""}
      className="my-2 flex items-center gap-2 px-3"
    >
      <div className="h-px flex-1 bg-border" />
      <span
        className={`inline-flex items-center gap-1 rounded-full border bg-bg-tertiary px-2 py-0.5 font-mono text-xs uppercase tracking-wider ${borderClass} ${textClass}`}
      >
        <span>{clean(fromStep)}</span>
        <span aria-hidden="true">→</span>
        <span>{clean(toStep)}</span>
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
