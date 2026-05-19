import type { ReactNode } from "react";
import type { TaskLevel } from "../../bindings";

type TaskLevelLabelCase = "title" | "lower";

interface TaskLevelLabelProps {
  level: TaskLevel | null;
  labelCase?: TaskLevelLabelCase;
  className?: string;
}

function formatTaskLevel(
  level: TaskLevel | null,
  labelCase: TaskLevelLabelCase
): string {
  if (level == null) return "—";
  if (labelCase === "lower") return level;

  switch (level) {
    case "epic":
      return "Epic";
    case "ticket":
      return "Ticket";
    case "task":
      return "Task";
    default:
      return level ?? "—";
  }
}

export function levelTextColor(level: TaskLevel | null): string {
  switch (level) {
    case "epic":
      return "text-info";
    case "ticket":
      return "text-primary";
    case "task":
      return "text-text-secondary";
    default:
      return "text-text-muted";
  }
}

export function TaskLevelLabel({
  level,
  labelCase = "title",
  className,
}: TaskLevelLabelProps): ReactNode {
  const label = formatTaskLevel(level, labelCase);
  const classes = [
    "font-mono text-xs uppercase tracking-wider",
    levelTextColor(level),
    className,
  ];

  return <span className={classes.filter(Boolean).join(" ")}>{label}</span>;
}
