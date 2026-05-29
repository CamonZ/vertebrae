import type { ReactNode } from "react";
import { formatStepName } from "../../utils/formatStepName";
import { Badge } from "../atoms/Badge";
import { Spinner } from "../Spinner";

export type TaskExecutionState =
  | "queued"
  | "executing"
  | "waiting"
  | "completed"
  | "failed"
  | "pending_review";

export type StatusBadgeState =
  | TaskExecutionState
  | { kind: "workflow"; workflow: string; step: string };

interface StatusBadgeProps {
  state: StatusBadgeState;
  size?: "sm" | "md";
  onClick?: () => void;
}

interface Display {
  label: string;
  intent: "neutral" | "accent" | "success" | "warning" | "error" | "info";
  spinner?: boolean;
}

function displayFor(
  state: Exclude<StatusBadgeState, { kind: "workflow" }>
): Display {
  switch (state) {
    case "queued":
      return { label: "Queued", intent: "neutral" };
    case "executing":
      return { label: "Running", intent: "info", spinner: true };
    case "waiting":
      return { label: "Waiting", intent: "warning" };
    case "completed":
      return { label: "Done", intent: "success" };
    case "failed":
      return { label: "Failed", intent: "error" };
    case "pending_review":
      return { label: "Needs Review", intent: "warning" };
  }
}

/**
 * Canonical representation of a task's current execution state. Use over raw
 * Badge for task surfaces so the vocabulary stays consistent.
 */
export function StatusBadge({ state, size = "sm", onClick }: StatusBadgeProps) {
  let badge: ReactNode;

  if (typeof state === "object") {
    // Workflow breadcrumb: a single two-tone segmented pill reading
    // "Workflow / Step", so the assignment and current step are one object.
    // Either segment may be omitted (unassigned task, or workflow with no
    // current step) and the divider only appears when both are present.
    const workflow = state.workflow;
    const step = formatStepName(state.step, "");
    badge = (
      <span className="inline-flex max-w-full items-center overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-line-strong)] text-2xs font-medium">
        {workflow && (
          <span className="truncate bg-[var(--color-bg-2)] px-2 py-0.5 text-[var(--color-fg-soft)]">
            {workflow}
          </span>
        )}
        {step && (
          <span
            className={`truncate bg-[var(--color-bg-3)] px-2 py-0.5 text-[var(--color-fg-mute)] ${
              workflow ? "border-l border-[var(--color-line-strong)]" : ""
            }`}
          >
            {step}
          </span>
        )}
      </span>
    );
  } else {
    const { label, intent, spinner } = displayFor(state);
    badge = (
      <Badge intent={intent} size={size} dot={!spinner}>
        <span className="inline-flex items-center gap-1.5">
          {spinner && <Spinner className="h-3 w-3" />}
          {label}
        </span>
      </Badge>
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="inline-flex rounded-[var(--radius-sm)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        {badge}
      </button>
    );
  }
  return badge;
}
