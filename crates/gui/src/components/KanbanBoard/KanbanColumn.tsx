import type { Step, Task } from "../../bindings";
import type { HearthStateBreakdown } from "../../utils/runState";
import { KanbanCard } from "./KanbanCard";
import { stepTypeStyle } from "../WorkflowPipeline/stepTypeStyling";
import { Count } from "../atoms";

interface KanbanColumnProps {
  columnName: string;
  tasks: Task[];
  selectedTaskId?: string | null;
  childBreakdowns?: Map<string, HearthStateBreakdown>;
  onTaskSelect?: (task: Task) => void;
  /**
   * The workflow step backing this column. When provided, the column gets a
   * 2px left border tinted with the step-type color so the board view shares
   * the same visual vocabulary as the pipeline DAG.
   */
  step?: Step | null;
}

export function KanbanColumn({
  columnName,
  tasks,
  selectedTaskId,
  childBreakdowns,
  onTaskSelect,
  step,
}: KanbanColumnProps) {
  const typeStyle = stepTypeStyle(step?.step_type);
  const isEmpty = tasks.length === 0;

  return (
    <div
      className="flex h-full min-w-72 max-w-md flex-1 flex-col rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg-1)] shadow-[inset_0_1px_0_color-mix(in_oklch,var(--color-fg)_5%,transparent)]"
      style={{ borderLeft: `2px solid var(${typeStyle.barVar})` }}
      role="region"
      aria-label={`${columnName} column, ${tasks.length} tasks`}
      data-step-kind={typeStyle.kind}
    >
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 font-mono text-eyebrow font-medium uppercase tracking-[0.16em] text-[var(--color-fg-mute)]">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full shadow-[0_0_10px_currentColor]"
            style={{
              color: `var(${typeStyle.fgVar})`,
              backgroundColor: "currentColor",
            }}
          />
          {step && (
            <span
              aria-hidden
              className="text-[12px] leading-none"
              style={{ color: `var(${typeStyle.fgVar})` }}
              title={typeStyle.label}
            >
              {typeStyle.icon}
            </span>
          )}
          <span
            className="truncate"
            style={{ color: `var(${typeStyle.fgVar})` }}
          >
            {columnName}
          </span>
        </h2>
        <Count
          data-testid="kanban-column-count"
          value={tasks.length}
          className="text-[16px]"
        />
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {isEmpty ? (
          <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-line)] bg-[var(--color-bg-2)] px-3 py-8 text-center font-mono text-eyebrow uppercase tracking-[0.12em] text-[var(--color-fg-faint)]">
            Nothing here
          </div>
        ) : (
          tasks.map((task) => (
            <KanbanCard
              key={task.id}
              task={task}
              isSelected={selectedTaskId === task.id}
              childBreakdown={childBreakdowns?.get(task.id)}
              onClick={onTaskSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}
