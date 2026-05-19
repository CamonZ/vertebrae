import type { TaskLevel } from "../../bindings";
import { NavigableReference } from "../shared/EntityId";

interface DependenciesSummaryProps {
  parentId: string | null;
  dependsOnIds: string[];
  dependentIds: string[];
  onTaskSelect?: (taskId: string) => void;
  getTaskLevel?: (taskId: string) => TaskLevel | null;
}

function TaskLink({
  taskId,
  level,
  onClick,
}: {
  taskId: string;
  level: TaskLevel | null;
  onClick?: (taskId: string) => void;
}) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick?.(taskId);
    }
  };

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => onClick?.(taskId)}
      onKeyDown={handleKeyDown}
      className="inline-flex items-center rounded bg-bg-tertiary px-2 py-0.5 transition-colors hover:bg-primary/10 cursor-pointer"
    >
      <NavigableReference
        id={taskId}
        kind="task"
        level={level}
        className="text-xs"
      />
    </span>
  );
}

function RelationRow({
  label,
  icon,
  taskIds,
  onTaskSelect,
  getTaskLevel,
}: {
  label: string;
  icon: React.ReactNode;
  taskIds: string[];
  onTaskSelect?: (taskId: string) => void;
  getTaskLevel?: (taskId: string) => TaskLevel | null;
}) {
  if (taskIds.length === 0) return null;

  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className="mt-0.5 flex-shrink-0 text-text-muted">{icon}</span>
      <div className="min-w-0">
        <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
          {label}
        </span>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {taskIds.map((id) => (
            <TaskLink
              key={id}
              taskId={id}
              level={getTaskLevel?.(id) ?? null}
              onClick={onTaskSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function DependenciesSummary({
  parentId,
  dependsOnIds,
  dependentIds,
  onTaskSelect,
  getTaskLevel,
}: DependenciesSummaryProps) {
  const hasAnyRelation =
    parentId !== null || dependsOnIds.length > 0 || dependentIds.length > 0;

  if (!hasAnyRelation) {
    return (
      <div className="px-4 py-3">
        <p className="text-xs text-text-muted italic">No dependencies</p>
      </div>
    );
  }

  return (
    <div className="space-y-1 px-4 py-3" data-testid="dependencies-summary">
      {parentId && (
        <RelationRow
          label="Parent"
          icon={
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M5 10l7-7m0 0l7 7m-7-7v18"
              />
            </svg>
          }
          taskIds={[parentId]}
          onTaskSelect={onTaskSelect}
          getTaskLevel={getTaskLevel}
        />
      )}
      <RelationRow
        label="Blocked by"
        icon={
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
            />
          </svg>
        }
        taskIds={dependsOnIds}
        onTaskSelect={onTaskSelect}
        getTaskLevel={getTaskLevel}
      />
      <RelationRow
        label="Blocking"
        icon={
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M13 7l5 5m0 0l-5 5m5-5H6"
            />
          </svg>
        }
        taskIds={dependentIds}
        onTaskSelect={onTaskSelect}
        getTaskLevel={getTaskLevel}
      />
    </div>
  );
}
