import type { KeyboardEvent } from "react";
import type { Task } from "../../bindings";
import { IdentityBadge } from "../shared/EntityId";

interface KanbanCardProps {
  task: Task;
  isSelected?: boolean;
  onClick?: (task: Task) => void;
}

function getStepStyles(stepName: string | null): {
  bg: string;
  text: string;
  glow?: string;
} {
  if (!stepName) {
    return {
      bg: "bg-[var(--color-bg-2)]",
      text: "text-[var(--color-fg-mute)]",
    };
  }
  const normalized = stepName.toLowerCase();
  switch (normalized) {
    case "backlog":
      return {
        bg: "bg-[var(--color-bg-2)]",
        text: "text-[var(--color-fg-mute)]",
      };
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
    default:
      return {
        bg: "bg-[var(--color-bg-2)]",
        text: "text-[var(--color-fg-mute)]",
      };
  }
}

function formatStepName(stepName: string | null): string {
  if (!stepName) return "No step";
  return (
    stepName.charAt(0).toUpperCase() + stepName.slice(1).replace(/_/g, " ")
  );
}

export function KanbanCard({
  task,
  isSelected = false,
  onClick,
}: KanbanCardProps) {
  const stepStyles = getStepStyles(task.step_name);

  const handleClick = () => {
    onClick?.(task);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick?.(task);
    }
  };

  return (
    <div
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label={`Task: ${task.title}`}
      className={`group cursor-pointer rounded-[var(--radius-md)] border p-3 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        isSelected
          ? "border-[var(--color-accent)] bg-[var(--color-accent-wash)]/40 shadow-[0_0_12px_var(--color-accent-glow)]"
          : "border-[var(--color-line)] bg-[var(--color-bg-2)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-bg-3)]"
      }`}
    >
      <div className="mb-2 flex items-center">
        <IdentityBadge
          id={task.id}
          kind="task"
          level={task.level}
          testId="kanban-card-id"
        />
      </div>

      {/* Title */}
      <h3 className="mb-2 text-sm font-medium leading-snug text-[var(--color-fg)]">
        {task.title}
      </h3>

      {/* Workflow name and step indicator */}
      <div className="flex flex-wrap items-center gap-1.5">
        {task.workflow_name && (
          <span className="inline-flex items-center rounded-[var(--radius-xs)] border border-[var(--color-line)] bg-[var(--color-bg-1)] px-1.5 py-0.5 text-2xs font-medium text-[var(--color-fg-soft)]">
            {task.workflow_name}
          </span>
        )}
        <span
          className={`inline-flex items-center rounded-[var(--radius-sm)] border border-current/30 px-2 py-0.5 text-2xs font-medium ${stepStyles.bg} ${stepStyles.text} ${stepStyles.glow ?? ""}`}
        >
          {formatStepName(task.step_name)}
        </span>
      </div>
    </div>
  );
}
