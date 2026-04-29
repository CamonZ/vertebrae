/**
 * StepBoundary — sticky-on-scroll divider that marks the start of a
 * (workflow, step, execution) section in the unified chat surface.
 *
 * Visually distinct from event rows: chip-style label badges, an
 * accent left border, and `position: sticky; top: 0` so the header
 * pins to the top of the scroll surface as the user scrolls past.
 */

import type { ReactNode } from "react";
import { formatCost } from "../../../utils/formatCost";
import { humanizeStepName } from "./EventRenderer";

interface StepBoundaryProps {
  executionId: string;
  taskId: string;
  taskTitle?: string | null;
  workflowName: string | null;
  stepName: string | null;
  startedAt: string | null;
  model: string | null;
  costUsd: number | null;
  /** Indentation level for nested delegation blocks (0 = root). */
  depth?: number;
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return ts;
  }
}

export function StepBoundary({
  executionId,
  taskId,
  taskTitle,
  workflowName,
  stepName,
  startedAt,
  model,
  costUsd,
  depth = 0,
}: StepBoundaryProps): ReactNode {
  const stepLabel = humanizeStepName(stepName);
  return (
    <div
      data-testid="unified-chat-step-boundary"
      data-execution-id={executionId}
      data-task-id={taskId}
      data-step-name={stepName ?? ""}
      data-depth={depth}
      className="sticky top-0 z-10 -mx-2 mb-2 flex flex-wrap items-center gap-2 border-l-2 border-primary bg-bg-secondary px-3 py-2 shadow-sm"
      style={{ marginLeft: depth * 16, marginRight: 0 }}
    >
      <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary">
        {workflowName ?? "workflow"}
      </span>
      <span className="text-text-muted">·</span>
      <span className="rounded bg-bg-tertiary px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-secondary">
        {stepLabel}
      </span>
      {taskTitle && (
        <>
          <span className="text-text-muted">·</span>
          <span className="truncate text-xs text-text-primary" title={taskTitle}>
            {taskTitle}
          </span>
        </>
      )}
      <span className="ml-auto flex items-center gap-3 text-[11px] text-text-muted">
        {startedAt && <span className="font-mono">{formatTimestamp(startedAt)}</span>}
        {model && <span className="font-mono">{model}</span>}
        {costUsd != null && costUsd > 0 && (
          <span className="font-mono text-success">{formatCost(costUsd)}</span>
        )}
      </span>
    </div>
  );
}
