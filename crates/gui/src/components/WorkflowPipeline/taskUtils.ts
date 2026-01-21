import type { TaskLevel } from "../../bindings";

/**
 * Get the CSS classes for a task card based on its status and selection state
 */
export function getStatusColor(status: string, isSelected: boolean): string {
  if (isSelected) {
    return "border-primary bg-primary/20 ring-1 ring-primary/50";
  }
  switch (status) {
    case "in_progress":
      return "border-accent bg-accent/10";
    case "completed":
    case "done":
      return "border-success/50 bg-success/5";
    case "failed":
      return "border-error bg-error/10";
    default:
      return "border-border bg-bg-tertiary ring-none";
  }
}

/**
 * Get the status icon character for a task status
 */
export function getStatusIcon(status: string): string {
  switch (status) {
    case "in_progress":
      return "⟳";
    case "completed":
    case "done":
      return "✓";
    case "failed":
      return "✕";
    default:
      return "○";
  }
}

/**
 * Get the CSS class for the level indicator dot color
 */
export function getLevelDotColor(level: TaskLevel): string {
  switch (level) {
    case "epic":
      return "bg-info";
    case "ticket":
      return "bg-primary";
    case "task":
      return "bg-text-secondary";
    default:
      return "bg-text-muted";
  }
}
