interface StepBadgeProps {
  /** Raw workflow step name (e.g. "in_progress"); null renders `emptyLabel`. */
  stepName: string | null;
  /** Label shown when `stepName` is null. */
  emptyLabel?: string;
  className?: string;
}

function getStepStyles(stepName: string | null): {
  bg: string;
  text: string;
  glow?: string;
} {
  if (!stepName) {
    return { bg: "bg-[var(--color-bg-2)]", text: "text-[var(--color-fg-mute)]" };
  }
  switch (stepName.toLowerCase()) {
    case "todo":
      return {
        bg: "bg-[var(--color-accent-wash)]",
        text: "text-[var(--color-accent)]",
      };
    case "in_progress":
    case "in progress":
      return {
        bg: "bg-[var(--color-warn-wash)]",
        text: "text-[var(--color-warn)]",
        glow: "shadow-[0_0_8px_var(--color-accent-glow)]",
      };
    case "pending_review":
    case "review":
      return {
        bg: "bg-[var(--color-info-wash)]",
        text: "text-[var(--color-info)]",
      };
    case "done":
      return {
        bg: "bg-[var(--color-ok-wash)]",
        text: "text-[var(--color-ok)]",
      };
    case "rejected":
      return {
        bg: "bg-[var(--color-err-wash)]",
        text: "text-[var(--color-err)]",
      };
    case "backlog":
    default:
      return { bg: "bg-[var(--color-bg-2)]", text: "text-[var(--color-fg-mute)]" };
  }
}

function formatStepName(stepName: string | null, emptyLabel: string): string {
  if (!stepName) return emptyLabel;
  return stepName.charAt(0).toUpperCase() + stepName.slice(1).replace(/_/g, " ");
}

/**
 * Canonical square status chip for a task's workflow step. Single source of
 * truth for the step's color vocabulary and shape across the tree view, kanban
 * cards, and the detail panel's children list — so "Done" reads identically
 * everywhere instead of drifting between square/rounded and tinted/grey.
 */
export function StepBadge({
  stepName,
  emptyLabel = "No step",
  className,
}: StepBadgeProps) {
  const styles = getStepStyles(stepName);
  return (
    <span
      className={[
        "inline-flex items-center rounded-[var(--radius-sm)] border border-current/30 px-2 py-0.5 text-2xs font-medium",
        styles.bg,
        styles.text,
        styles.glow,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {formatStepName(stepName, emptyLabel)}
    </span>
  );
}
