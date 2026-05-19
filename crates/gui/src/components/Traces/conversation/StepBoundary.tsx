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

import { useState, type ReactNode } from "react";
import { formatCost } from "../../../utils/formatCost";
import { MarkdownContent } from "../../shared/MarkdownContent";
import {
  thresholdKindBorderClass,
  thresholdKindClass,
} from "../levelColors";
import type { ThresholdMarkerKind } from "../timeline";
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
  /** Prompt used to drive this step execution. When set, rendered as a collapsible markdown section. */
  prompt?: string | null;
  /**
   * When this boundary represents a workflow threshold (rejection, approval,
   * model_fallback, etc.), the kind drives a per-kind tint on the left border
   * and adds a kind-tagged callout chip. The mapping mirrors FlightStrip's
   * threshold lane via `thresholdKindClass` so the chat and strip read as one
   * system. Null = no threshold affordance (vanilla boundary).
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
  prompt = null,
  thresholdKind = null,
}: StepBoundaryProps): ReactNode {
  const stepLabel = humanizeStepName(stepName);
  const showTitleInline = !!taskTitle && taskTitlePlacement === "inline";
  const showTitleSubtitle = !!taskTitle && taskTitlePlacement === "subtitle";
  const hasPrompt = !!prompt && prompt.trim().length > 0;
  const [promptExpanded, setPromptExpanded] = useState(false);
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
      className={`sticky top-0 z-10 -mx-2 mb-2 border-l-2 ${borderClass} bg-bg-secondary px-3 py-2 shadow-sm`}
      style={{ marginLeft: depth * 16, marginRight: 0 }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {thresholdKind && (
          <span
            data-testid="step-boundary-threshold-callout"
            data-kind={thresholdKind}
            className={`rounded border border-current px-2 py-0.5 font-mono text-xs uppercase tracking-wider ${thresholdKindClass(thresholdKind)}`}
          >
            {humanizeStepName(thresholdKind)}
          </span>
        )}
        <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-primary">
          {workflowName ?? "workflow"}
        </span>
        <span className="text-text-muted">·</span>
        <span className="rounded bg-bg-tertiary px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-text-secondary">
          {stepLabel}
        </span>
        {model && (
          <>
            <span className="text-text-muted">·</span>
            <span
              data-testid="step-boundary-model"
              className="font-mono text-xs uppercase tracking-wider text-text-secondary"
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
        <span className="ml-auto flex items-center gap-3 text-xs text-text-muted">
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
      {hasPrompt && (
        <div className="mt-2">
          <button
            type="button"
            data-testid="step-boundary-prompt-toggle"
            aria-expanded={promptExpanded}
            onClick={() => setPromptExpanded((v) => !v)}
            className="flex items-center gap-1 font-mono text-xs uppercase tracking-wider text-text-muted hover:text-text-secondary"
          >
            <span aria-hidden="true">{promptExpanded ? "▾" : "▸"}</span>
            <span>Prompt</span>
          </button>
          {promptExpanded && (
            <div
              data-testid="step-boundary-prompt"
              className="mt-1 max-h-96 overflow-auto rounded border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            >
              <MarkdownContent text={prompt as string} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
