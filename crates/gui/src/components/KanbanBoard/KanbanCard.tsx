import type { KeyboardEvent } from "react";
import type { Task } from "../../bindings";
import { deriveHearthRunChipState } from "../../utils/runState";
import { useActiveTaskRun } from "../../hooks/useTaskRuns";
import { useTaskLocation } from "../../hooks/useTaskLocation";
import {
  hearthStepKind,
  hearthStepStyle,
} from "../WorkflowPipeline/stepTypeStyling";
import { Glyph, IdChip } from "../shared/HearthPrimitives";

interface KanbanCardProps {
  task: Task;
  isSelected?: boolean;
  onClick?: (task: Task) => void;
}

export function KanbanCard({
  task,
  isSelected = false,
  onClick,
}: KanbanCardProps) {
  const location = useTaskLocation(task);
  const stepKind = hearthStepKind(location.stepType);
  const stepStyle = hearthStepStyle(stepKind);
  const activeRun = useActiveTaskRun(task.id);
  const runStatus = activeRun?.status ?? null;
  const runChip = deriveHearthRunChipState(runStatus, {
    includeTerminal: isSelected,
  });
  const isCompleted = Boolean(task.completed_at || runStatus === "completed");
  const isRunning = Boolean(runChip?.isActive);
  const isEpic = task.level === "epic";
  const showLeftBar = isSelected || isRunning;

  // Background by state. Selected uses the shared neutral selection surface
  // (same as the Tasks list / Run Console selected rows); running keeps the live gradient. Resting
  // is left to a class so `hover:` can override it (an inline style could not).
  // The step-kind hue lives only in the 2px top bar (borderTopColor).
  const stateBackground = isSelected
    ? "var(--color-selection)"
    : isRunning
      ? "linear-gradient(135deg, var(--color-accent-wash), var(--color-bg-2) 50%)"
      : undefined;

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
      className={`group relative flex shrink-0 cursor-pointer items-start gap-2 overflow-hidden rounded-[var(--radius-md)] border border-t-2 px-3 py-2 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        isSelected
          ? "border-[var(--color-line-strong)]"
          : isRunning
            ? "border-[color-mix(in_oklch,var(--color-accent)_30%,var(--color-line-strong))] shadow-[0_0_18px_color-mix(in_oklch,var(--color-accent)_16%,transparent)]"
            : "border-[var(--color-line-strong)] bg-[var(--color-bg-2)] hover:bg-[var(--row-hover)]"
      } ${
        showLeftBar
          ? "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-[var(--color-accent)] before:content-['']"
          : ""
      } ${isCompleted ? "opacity-65" : ""}`}
      style={{
        borderTopColor: `var(${stepStyle.barVar})`,
        ...(stateBackground ? { background: stateBackground } : {}),
      }}
    >
      <Glyph level={task.level} accent={runChip?.state === "running"} />
      <h3
        className={`min-w-0 flex-1 leading-snug text-[var(--color-fg)] line-clamp-2 ${
          isEpic
            ? "font-serif text-base font-normal italic tracking-tight"
            : "text-sm font-medium"
        }`}
      >
        {task.title}
      </h3>
      <IdChip
        id={task.id}
        kind="task"
        level={task.level}
        testId="kanban-card-id"
      />
    </div>
  );
}
