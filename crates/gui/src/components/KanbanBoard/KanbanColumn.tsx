import type { Task } from "../../bindings";
import { KanbanCard } from "./KanbanCard";

interface KanbanColumnProps {
  columnName: string;
  tasks: Task[];
  selectedTaskId?: string | null;
  onTaskSelect?: (task: Task) => void;
}

export function KanbanColumn({
  columnName,
  tasks,
  selectedTaskId,
  onTaskSelect,
}: KanbanColumnProps) {
  return (
    <div
      className="flex h-full min-w-72 max-w-md flex-1 flex-col rounded-lg border border-border bg-bg-secondary"
      role="region"
      aria-label={`${columnName} column, ${tasks.length} tasks`}
    >
      {/* Column header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-mono text-[10px] font-medium uppercase tracking-wider text-text-muted">
          {columnName}
        </h2>
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-bg-tertiary px-1.5 font-mono text-[10px] font-medium text-text-muted">
          {tasks.length}
        </span>
      </div>

      {/* Scrollable card list */}
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {tasks.length === 0 ? (
          <p className="py-8 text-center text-xs text-text-muted">
            No tasks
          </p>
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
