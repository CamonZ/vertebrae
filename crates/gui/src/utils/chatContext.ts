import type { ChatScope } from "../stores/chatStore";

/**
 * Get a scope label for display affordances.
 */
export function scopeLabel(scope: ChatScope): string {
  switch (scope) {
    case "project":
      return "Project";
    case "workflow":
      return "Workflow";
    case "task":
      return "Task";
    case "step":
      return "Step";
  }
}
