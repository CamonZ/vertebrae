import type { TaskLevel } from "../../bindings";

/**
 * Get the CSS classes for a task card based on its status and selection state
 */
export function getStatusColor(status: string, isSelected: boolean): string {
  if (isSelected) {
    return "border-accent bg-accent/20 ring-1 ring-accent/50";
  }
  switch (status) {
    case "in_progress":
      return "border-accent bg-accent/10";
    case "completed":
    case "done":
      return "border-ok/50 bg-ok/5";
    case "failed":
      return "border-err bg-err/10";
    default:
      return "border-border bg-bg-2 ring-none";
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
      return "bg-accent";
    case "task":
      return "bg-fg-soft";
    default:
      return "bg-fg-mute";
  }
}
