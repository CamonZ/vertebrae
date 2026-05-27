import type { KeyboardEvent } from "react";
import type { Task } from "../../bindings";
import { IdentityBadge } from "../shared/EntityId";
import { LevelMark } from "../shared/LevelMark";
import { StatusBadge } from "../molecules/StatusBadge";

interface KanbanCardProps {
  task: Task;
  isSelected?: boolean;
  onClick?: (task: Task) => void;
}

export function KanbanCard({ task, isSelected = false, onClick }: KanbanCardProps) {
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
      className={`group relative cursor-pointer overflow-hidden rounded-[var(--radius-md)] border p-3 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        isSelected
          ? "border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_8%,var(--color-bg))] shadow-[0_0_12px_var(--color-accent-glow)] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-[var(--color-accent)] before:content-['']"
          : "border-[var(--color-line)] bg-[var(--color-bg-2)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-bg-3)]"
      }`}
    >
      {/* Title row: level mark + title */}
      <div className="flex items-start gap-2">
        <LevelMark level={task.level} className="mt-0.5 h-5 w-4" />
        <h3 className="min-w-0 flex-1 text-sm font-medium leading-snug text-[var(--color-fg)]">
          {task.title}
        </h3>
      </div>

      {/* Workflow / step breadcrumb */}
      {(task.workflow_name || task.step_name) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <StatusBadge
            state={{
              kind: "workflow",
              workflow: task.workflow_name ?? "",
              step: task.step_name ?? "",
            }}
          />
        </div>
      )}

      {/* ID on its own line */}
      <div className="mt-2 flex items-center">
        <IdentityBadge
          id={task.id}
          kind="task"
          level={task.level}
          testId="kanban-card-id"
        />
      </div>
    </div>
  );
}
