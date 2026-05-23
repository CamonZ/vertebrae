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

function displayFor(state: StatusBadgeState): Display {
  if (typeof state === "object") {
    return {
      label: `${state.workflow} / ${state.step}`,
      intent: "neutral",
    };
  }
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
  const { label, intent, spinner } = displayFor(state);

  const badge = (
    <Badge intent={intent} size={size} dot={!spinner}>
      <span className="inline-flex items-center gap-1.5">
        {spinner && <Spinner className="h-3 w-3" />}
        {label}
      </span>
    </Badge>
  );

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
