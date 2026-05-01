/**
 * StepBoundary — sticky-on-scroll divider that marks the start of a
 * (workflow, step, execution) section in the unified chat surface.
 *
 * Visually distinct from event rows: chip-style label badges, an
 * accent left border, and `position: sticky; top: 0` so the header
 * pins to the top of the scroll surface as the user scrolls past.
 *
 * Session facts (model, duration, turn count, cost) that previously
 * rendered as standalone "Session Started" / "Session Complete" cards
 * inside the conversation are folded into the header here — that's
 * the trio shown right of the timestamp.
 */

import type { ReactNode } from "react";
import { formatCost } from "../../../utils/formatCost";
import { formatDurationShort, humanizeStepName } from "./EventRenderer";

/**
 * How the task title is presented in the header.
 *
 * - `inline`   — title appears on the badge row after the step chip.
 *                Used for descendant tasks in subtree views where
 *                multiple tasks coexist in the same scroll surface.
 * - `subtitle` — title appears on a secondary line under the badge row.
 *                Used for descendant tasks in multi-task subtree views
 *                so they read as "delegated to: ...".
 * - `hidden`   — title is omitted entirely. Used when the Traces view
 *                is scoped to a single task (taskId in URL) — the page
 *                title already shows it, so repeating it on every
 *                boundary is just noise.
 */
export type TaskTitlePlacement = "inline" | "subtitle" | "hidden";

interface StepBoundaryProps {
  executionId: string;
  taskId: string;
  taskTitle?: string | null;
  taskTitlePlacement?: TaskTitlePlacement;
  workflowName: string | null;
  stepName: string | null;
  startedAt: string | null;
  model: string | null;
  costUsd: number | null;
  /** Wall-time of the execution (ms). When set, rendered in the right-side trio. */
  durationMs?: number | null;
  /** Total assistant turns in the execution. When set, rendered in the right-side trio. */
  numTurns?: number | null;
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
  taskTitlePlacement = "inline",
  workflowName,
  stepName,
  startedAt,
  model,
  costUsd,
  durationMs,
  numTurns,
  depth = 0,
}: StepBoundaryProps): ReactNode {
  const stepLabel = humanizeStepName(stepName);
  const showTitleInline = !!taskTitle && taskTitlePlacement === "inline";
  const showTitleSubtitle = !!taskTitle && taskTitlePlacement === "subtitle";

  return (
    <div
      data-testid="unified-chat-step-boundary"
      data-execution-id={executionId}
      data-task-id={taskId}
      data-step-name={stepName ?? ""}
      data-depth={depth}
      data-task-title-placement={taskTitlePlacement}
      className="sticky top-0 z-10 -mx-2 mb-2 border-l-2 border-primary bg-bg-secondary px-3 py-2 shadow-sm"
      style={{ marginLeft: depth * 16, marginRight: 0 }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary">
          {workflowName ?? "workflow"}
        </span>
        <span className="text-text-muted">·</span>
        <span className="rounded bg-bg-tertiary px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-secondary">
          {stepLabel}
        </span>
        {model && (
          <>
            <span className="text-text-muted">·</span>
            <span
              data-testid="step-boundary-model"
              className="font-mono text-[10px] uppercase tracking-wider text-text-secondary"
            >
              {model}
            </span>
          </>
        )}
        {showTitleInline && (
          <>
            <span className="text-text-muted">·</span>
            <span
              data-testid="step-boundary-task-title"
              className="truncate text-xs text-text-primary"
              title={taskTitle ?? undefined}
            >
              {taskTitle}
            </span>
          </>
        )}
        <span className="ml-auto flex items-center gap-3 text-[11px] text-text-muted">
          {startedAt && <span className="font-mono">{formatTimestamp(startedAt)}</span>}
          {durationMs != null && durationMs > 0 && (
            <span data-testid="step-boundary-duration" className="font-mono">
              {formatDurationShort(durationMs)}
            </span>
          )}
          {numTurns != null && numTurns > 0 && (
            <span data-testid="step-boundary-turns" className="font-mono">
              {numTurns} {numTurns === 1 ? "turn" : "turns"}
            </span>
          )}
          {costUsd != null && costUsd > 0 && (
            <span
              data-testid="step-boundary-cost"
              className="font-mono text-success"
            >
              {formatCost(costUsd)}
            </span>
          )}
        </span>
      </div>
      {showTitleSubtitle && (
        <div
          data-testid="step-boundary-task-subtitle"
          className="mt-1 truncate text-xs text-text-secondary"
          title={taskTitle ?? undefined}
        >
          {taskTitle}
        </div>
      )}
    </div>
  );
}
