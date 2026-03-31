interface DependenciesSummaryProps {
  parentId: string | null;
  dependsOnIds: string[];
  dependentIds: string[];
  onTaskSelect?: (taskId: string) => void;
}

function truncateId(id: string): string {
  return id.slice(0, 8);
}

function TaskLink({
  taskId,
  onClick,
}: {
  taskId: string;
  onClick?: (taskId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick?.(taskId)}
      className="inline-flex items-center rounded bg-bg-tertiary px-2 py-0.5 font-mono text-[11px] text-text-secondary transition-colors hover:bg-primary/10 hover:text-primary cursor-pointer"
      title={`View task ${taskId}`}
    >
      {truncateId(taskId)}
    </button>
  );
}

function RelationRow({
  label,
  icon,
  taskIds,
  onTaskSelect,
}: {
  label: string;
  icon: React.ReactNode;
  taskIds: string[];
  onTaskSelect?: (taskId: string) => void;
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
            <TaskLink key={id} taskId={id} onClick={onTaskSelect} />
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
      />
    </div>
  );
}
