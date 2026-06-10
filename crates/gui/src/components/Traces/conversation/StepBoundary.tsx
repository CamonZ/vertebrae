/**
 * StepBoundary — thin centered divider chip ("— STEP · ▶ EXECUTE · 4m ago —")
 * marking the start of a (workflow, step, execution) section in the chat
 * surface. Replaces the legacy sticky header: prompts now render as a USER
 * bubble (see {@link UnifiedChatView}) instead of a collapsible toggle inline
 * on the boundary, and the chip rides the scroll surface naturally rather
 * than pinning to the top.
 *
 * The divider still folds the session_start / session_end facts (model,
 * duration, turn count, cost) into the right-hand metadata slot — they were
 * previously rendered as standalone "Session Started" / "Session Complete"
 * cards in the conversation stream.
 */

import { type ReactNode } from "react";
import { formatCost } from "../../../utils/formatCost";
import {
  thresholdKindBorderClass,
  thresholdKindClass,
} from "../levelColors";
import type { ThresholdMarkerKind } from "../legacyMarkers";
import { formatDurationShort, humanizeStepName } from "./EventRenderer";

/**
 * How the task title is presented on the divider.
 *
 * - `inline`   — title appears on the divider chip after the step label.
 *                Used for descendant tasks in subtree views where multiple
 *                tasks coexist in the same scroll surface.
 * - `subtitle` — title appears on a second line beneath the divider.
 *                Used for delegated child tasks so they read as
 *                "delegated to: ...".
 * - `hidden`   — title is omitted entirely. Used when the Traces view is
 *                scoped to a single task (page title already shows it).
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
  /** Wall-time of the execution (ms). When set, rendered in the right trio. */
  durationMs?: number | null;
  /** Total assistant turns in the execution. When set, rendered in the trio. */
  numTurns?: number | null;
  /** Indentation level for nested delegation blocks (0 = root). */
  depth?: number;
  /**
   * When this boundary represents a workflow threshold (rejection, approval,
   * model_fallback, etc.), the kind drives a per-kind tint on the chip and
   * adds a kind-tagged callout. Mirrors FlightStrip's threshold lane via
   * `thresholdKindClass`. Null = no threshold affordance (vanilla divider).
   */
  thresholdKind?: ThresholdMarkerKind | null;
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
  thresholdKind = null,
}: StepBoundaryProps): ReactNode {
  const stepLabel = humanizeStepName(stepName);
  const showTitleInline = !!taskTitle && taskTitlePlacement === "inline";
  const showTitleSubtitle = !!taskTitle && taskTitlePlacement === "subtitle";
  // Border-style intentionally kept on the chip via `thresholdKindBorderClass`
  // so the divider inherits the same level-tint story as FlightStrip when a
  // threshold (rejection/approval) is in play.
  const borderClass = thresholdKindBorderClass(thresholdKind);

  return (
    <div
      data-testid="unified-chat-step-boundary"
      data-execution-id={executionId}
      data-task-id={taskId}
      data-step-name={stepName ?? ""}
      data-depth={depth}
      data-task-title-placement={taskTitlePlacement}
      data-threshold-kind={thresholdKind ?? ""}
      className="my-3 flex flex-col items-center gap-1 px-4"
      style={{ marginLeft: depth * 16, marginRight: 0 }}
    >
      <div className="flex w-full items-center gap-2">
        <div className="h-px flex-1 bg-[var(--color-line)]" />
        <div
          className={`flex items-center gap-2 rounded-[var(--radius-full)] border bg-[var(--color-bg-1)] px-3 py-1 font-mono text-2xs uppercase tracking-wider text-[var(--color-fg-mute)] ${borderClass}`}
        >
          {thresholdKind && (
            <span
              data-testid="step-boundary-threshold-callout"
              data-kind={thresholdKind}
              className={`rounded-[var(--radius-sm)] border border-current px-1.5 py-0.5 ${thresholdKindClass(thresholdKind)}`}
            >
              {humanizeStepName(thresholdKind)}
            </span>
          )}
          <span className="text-[var(--color-fg-soft)]">
            {workflowName ?? "workflow"}
          </span>
          <span aria-hidden>·</span>
          <span className="text-[var(--color-accent)]">▶ {stepLabel}</span>
          {model && (
            <>
              <span aria-hidden>·</span>
              <span data-testid="step-boundary-model">{model}</span>
            </>
          )}
          {showTitleInline && (
            <>
              <span aria-hidden>·</span>
              <span
                data-testid="step-boundary-task-title"
                className="max-w-[24ch] truncate text-[var(--color-fg-soft)]"
                title={taskTitle ?? undefined}
              >
                {taskTitle}
              </span>
            </>
          )}
          {startedAt && (
            <>
              <span aria-hidden>·</span>
              <span>{formatTimestamp(startedAt)}</span>
            </>
          )}
          {durationMs != null && durationMs > 0 && (
            <>
              <span aria-hidden>·</span>
              <span data-testid="step-boundary-duration">
                {formatDurationShort(durationMs)}
              </span>
            </>
          )}
          {numTurns != null && numTurns > 0 && (
            <>
              <span aria-hidden>·</span>
              <span data-testid="step-boundary-turns">
                {numTurns} {numTurns === 1 ? "turn" : "turns"}
              </span>
            </>
          )}
          {costUsd != null && costUsd > 0 && (
            <>
              <span aria-hidden>·</span>
              <span
                data-testid="step-boundary-cost"
                className="text-[var(--color-ok)]"
              >
                {formatCost(costUsd)}
              </span>
            </>
          )}
        </div>
        <div className="h-px flex-1 bg-[var(--color-line)]" />
      </div>
      {showTitleSubtitle && (
        <div
          data-testid="step-boundary-task-subtitle"
          className="max-w-[60ch] truncate text-xs text-[var(--color-fg-soft)]"
          title={taskTitle ?? undefined}
        >
          {taskTitle}
        </div>
      )}
    </div>
  );
}
