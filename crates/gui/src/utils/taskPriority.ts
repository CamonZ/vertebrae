import type { TaskPriority } from "../bindings";

export interface PriorityIndicator {
  glyph: string;
  color: string;
  label: string;
}

export function getPriorityIndicator(
  priority: TaskPriority | null | undefined
): PriorityIndicator | null {
  switch (priority) {
    case "critical":
      return {
        glyph: "↑",
        color: "text-[var(--color-err)]",
        label: "Critical priority",
      };
    case "high":
      return {
        glyph: "↑",
        color: "text-[var(--color-warn)]",
        label: "High priority",
      };
    case "medium":
      return {
        glyph: "→",
        color: "text-[var(--color-fg-soft)]",
        label: "Medium priority",
      };
    case "low":
      return {
        glyph: "↓",
        color: "text-[var(--color-fg-mute)]",
        label: "Low priority",
      };
    default:
      return null;
  }
}
