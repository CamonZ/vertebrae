import type { KeyboardEvent } from "react";
import type { Task, TaskLevel } from "../../bindings";

interface KanbanCardProps {
  task: Task;
  isSelected?: boolean;
  onClick?: (task: Task) => void;
}

function getLevelStyles(level: TaskLevel): { bg: string; text: string; border: string } {
  switch (level) {
    case "epic":
      return { bg: "bg-info/10", text: "text-info", border: "border-info/30" };
    case "ticket":
      return { bg: "bg-primary/10", text: "text-primary", border: "border-primary/30" };
    case "task":
      return { bg: "bg-bg-tertiary", text: "text-text-secondary", border: "border-border" };
    default:
      return { bg: "bg-bg-tertiary", text: "text-text-muted", border: "border-border" };
  }
}

function formatLevel(level: TaskLevel): string {
  switch (level) {
    case "epic":
      return "Epic";
    case "ticket":
      return "Ticket";
    case "task":
      return "Task";
    default:
      return level;
  }
}

function getStepStyles(stepName: string | null): { bg: string; text: string; glow?: string } {
  if (!stepName) {
    return { bg: "bg-bg-tertiary", text: "text-text-muted" };
  }
  const normalized = stepName.toLowerCase();
  switch (normalized) {
    case "backlog":
      return { bg: "bg-bg-tertiary", text: "text-text-muted" };
    case "todo":
      return { bg: "bg-primary/10", text: "text-primary" };
    case "in_progress":
    case "in progress":
      return { bg: "bg-warning/10", text: "text-warning", glow: "shadow-[0_0_8px_rgba(245,158,11,0.3)]" };
    case "pending_review":
    case "review":
      return { bg: "bg-info/10", text: "text-info" };
    case "done":
      return { bg: "bg-success/10", text: "text-success" };
    case "rejected":
      return { bg: "bg-error/10", text: "text-error" };
    default:
      return { bg: "bg-bg-tertiary", text: "text-text-muted" };
  }
}

function formatStepName(stepName: string | null): string {
  if (!stepName) return "No step";
  return stepName.charAt(0).toUpperCase() + stepName.slice(1).replace(/_/g, " ");
}

export function KanbanCard({ task, isSelected = false, onClick }: KanbanCardProps) {
  const levelStyles = getLevelStyles(task.level);
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
      className={`group cursor-pointer rounded-lg border p-3 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        isSelected
          ? "border-primary/50 bg-primary/5 shadow-glow-sm"
          : "border-border bg-bg-primary hover:border-border/80 hover:bg-bg-hover"
      }`}
    >
      {/* Header: ID and level badge */}
      <div className="mb-2 flex items-center justify-between">
        <code className="font-mono text-[10px] text-text-muted">
          {task.id.slice(0, 8)}
        </code>
        <span
          className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${levelStyles.bg} ${levelStyles.text} ${levelStyles.border}`}
        >
          {formatLevel(task.level)}
        </span>
      </div>

      {/* Title */}
      <h3 className="mb-2 text-sm font-medium leading-snug text-text-primary">
        {task.title}
      </h3>

      {/* Workflow name and step indicator */}
      <div className="flex flex-wrap items-center gap-1.5">
        {task.workflow_name && (
          <span className="inline-flex items-center rounded border border-border bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
            {task.workflow_name}
          </span>
        )}
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${stepStyles.bg} ${stepStyles.text} ${stepStyles.glow ?? ""}`}
        >
          {formatStepName(task.step_name)}
        </span>
      </div>

      {/* Review indicator */}
      {task.needs_human_review && (
        <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-warning">
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
          Review
        </span>
      )}
    </div>
  );
}
