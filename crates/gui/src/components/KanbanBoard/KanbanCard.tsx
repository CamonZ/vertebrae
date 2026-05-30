import type { KeyboardEvent } from "react";
import type { Task } from "../../bindings";
import type { HearthStateBreakdown } from "../../utils/runState";
import {
  deriveHearthRunChipState,
  hasHearthStateBreakdown,
} from "../../utils/runState";
import { formatStepName } from "../../utils/formatStepName";
import { getPriorityIndicator } from "../../utils/taskPriority";
import {
  hearthStepStyle,
  type HearthStepKind,
} from "../WorkflowPipeline/stepTypeStyling";
import {
  Glyph,
  IdChip,
  KindChip,
  RunChip,
  StateBreakdown,
} from "../shared/HearthPrimitives";

interface KanbanCardProps {
  task: Task;
  isSelected?: boolean;
  childBreakdown?: HearthStateBreakdown;
  onClick?: (task: Task) => void;
}

function inferStepKind(task: Task): HearthStepKind {
  const value =
    `${task.step_name ?? ""} ${task.workflow_name ?? ""}`.toLowerCase();
  if (value.includes("eval") || value.includes("review")) return "eval";
  if (value.includes("human")) return "human";
  if (value.includes("wait")) return "wait";
  if (value.includes("route") || value.includes("triage")) return "route";
  if (
    value.includes("implement") ||
    value.includes("run") ||
    value.includes("execute")
  ) {
    return "execute";
  }
  return "unknown";
}

export function KanbanCard({
  task,
  isSelected = false,
  childBreakdown,
  onClick,
}: KanbanCardProps) {
  const stepKind = inferStepKind(task);
  const stepStyle = hearthStepStyle(stepKind);
  const runStatus = task.run_controls?.active_run?.status ?? null;
  const runChip = deriveHearthRunChipState(runStatus, {
    includeTerminal: isSelected,
  });
  const priority = getPriorityIndicator(task.priority);
  const isCompleted = Boolean(task.completed_at || runStatus === "completed");
  const showBreakdown = Boolean(
    childBreakdown && hasHearthStateBreakdown(childBreakdown)
  );

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
      data-kind={stepKind}
      data-running={runChip?.isActive || undefined}
      data-completed={isCompleted || undefined}
      data-priority={task.priority ?? undefined}
      className={`group relative cursor-pointer overflow-hidden rounded-[var(--radius-md)] border border-t-2 p-3 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        isSelected
          ? "border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_8%,var(--color-bg-1))] shadow-[0_0_14px_var(--color-accent-glow)] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-[var(--color-accent)] before:content-['']"
          : "border-[var(--color-line)] bg-[var(--color-bg-1)] hover:-translate-y-0.5 hover:border-[var(--color-line-strong)] hover:bg-[var(--color-bg-2)]"
      } ${runChip?.isActive ? "shadow-[0_0_18px_color-mix(in_oklch,var(--color-accent)_16%,transparent)]" : ""} ${
        isCompleted ? "opacity-65" : ""
      }`}
      style={{
        borderTopColor: `var(${stepStyle.barVar})`,
        backgroundColor: `color-mix(in oklch, var(${stepStyle.washVar}) 10%, var(--color-bg-1))`,
      }}
    >
      <div className="flex items-start gap-2">
        <Glyph level={task.level} accent={runChip?.state === "running"} />
        <h3 className="min-w-0 flex-1 text-sm font-medium leading-snug text-[var(--color-fg)]">
          {task.title}
        </h3>
        {priority && (
          <span
            className={`font-mono text-xs font-semibold ${priority.color}`}
            title={priority.label}
            aria-label={priority.label}
          >
            {priority.glyph}
          </span>
        )}
      </div>

      {(task.workflow_name || task.step_name) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <KindChip
            kind={stepKind}
            label={
              task.step_name
                ? formatStepName(task.step_name, stepStyle.label)
                : stepStyle.label
            }
          />
          {task.workflow_name && (
            <span className="max-w-full truncate font-mono text-2xs uppercase tracking-[0.1em] text-[var(--color-fg-faint)]">
              {task.workflow_name}
            </span>
          )}
        </div>
      )}

      {showBreakdown && (
        <div className="mt-2">
          <StateBreakdown {...childBreakdown} />
        </div>
      )}

      {task.tags && task.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-2xs text-[var(--color-fg-faint)]">
          {task.tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="border-b border-dotted border-[var(--color-fg-ghost)]"
            >
              {tag}
            </span>
          ))}
          {task.tags.length > 2 && <span>+{task.tags.length - 2}</span>}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <RunChip status={runStatus} small />
        <IdChip
          id={task.id}
          kind="task"
          level={task.level}
          testId="kanban-card-id"
        />
      </div>
    </div>
  );
}
