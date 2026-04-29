/**
 * TransitionMarker — inline "from → to" chip between two consecutive step
 * executions on the same task. Visually subtler than StepBoundary because
 * it only signals the transition decision, not a new section header.
 */

import type { ReactNode } from "react";
import { humanizeStepName } from "./EventRenderer";

interface TransitionMarkerProps {
  fromStep: string | null;
  toStep: string | null;
  taskId: string;
}

function clean(name: string | null): string {
  return name ? humanizeStepName(name) : "?";
}

export function TransitionMarker({
  fromStep,
  toStep,
  taskId,
}: TransitionMarkerProps): ReactNode {
  return (
    <div
      data-testid="unified-chat-transition"
      data-task-id={taskId}
      data-from-step={fromStep ?? ""}
      data-to-step={toStep ?? ""}
      className="my-2 flex items-center gap-2 px-3"
    >
      <div className="h-px flex-1 bg-border" />
      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-tertiary px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-secondary">
        <span>{clean(fromStep)}</span>
        <span aria-hidden="true">→</span>
        <span>{clean(toStep)}</span>
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
