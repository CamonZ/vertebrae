import type { Step, Task } from "../../bindings";
import { KanbanCard } from "./KanbanCard";
import { stepTypeStyle } from "../WorkflowPipeline/stepTypeStyling";

interface KanbanColumnProps {
  columnName: string;
  tasks: Task[];
  selectedTaskId?: string | null;
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
  onTaskSelect,
  step,
}: KanbanColumnProps) {
  const typeStyle = stepTypeStyle(step?.step_type);
  return (
    <div
      className="flex h-full min-w-72 max-w-md flex-1 flex-col rounded-lg border border-border bg-bg-secondary"
      style={{ borderLeft: `2px solid var(${typeStyle.barVar})` }}
      role="region"
      aria-label={`${columnName} column, ${tasks.length} tasks`}
      data-step-kind={typeStyle.kind}
    >
      {/* Column header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-wider text-text-muted">
          <span style={{ color: `var(${typeStyle.fgVar})` }}>{columnName}</span>
          {step && (
            <span
              aria-hidden
              className="text-[12px]"
              style={{ color: `var(${typeStyle.fgVar})` }}
              title={typeStyle.label}
            >
              {typeStyle.icon}
            </span>
          )}
        </h2>
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-bg-tertiary px-1.5 font-mono text-[10px] font-medium text-text-muted">
          {tasks.length}
        </span>
      </div>

      {/* Scrollable card list */}
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {tasks.length === 0 ? (
          <p className="py-8 text-center text-xs text-text-muted">No tasks</p>
        ) : (
          tasks.map((task) => (
            <KanbanCard
              key={task.id}
              task={task}
              isSelected={selectedTaskId === task.id}
              onClick={onTaskSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}
