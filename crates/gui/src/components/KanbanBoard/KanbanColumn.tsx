import type { Task } from "../../bindings";
import { KanbanCard } from "./KanbanCard";
import { Count } from "../atoms";

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
  const isEmpty = tasks.length === 0;

  return (
    <div
      className="flex h-full min-w-72 max-w-md shrink-0 grow basis-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[color-mix(in_oklch,var(--color-bg-1)_50%,var(--color-bg))]"
      role="region"
      aria-label={`${columnName} column, ${tasks.length} tasks`}
    >
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-3">
        <h2 className="min-w-0 truncate font-mono text-eyebrow font-medium uppercase tracking-eyebrow text-[var(--color-fg-mute)]">
          {columnName}
        </h2>
        <Count
          data-testid="kanban-column-count"
          value={tasks.length}
          className="text-lg"
        />
      </div>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
        {isEmpty ? (
          <div className="flex flex-1 items-center justify-center px-4 py-6 text-center font-serif text-sm italic text-[var(--color-fg-faint)]">
            Nothing here
          </div>
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
