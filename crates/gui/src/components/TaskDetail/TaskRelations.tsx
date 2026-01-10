interface TaskRelationsProps {
  parentId: string | null;
  childrenIds: string[];
  dependsOnIds: string[];
  dependentIds: string[];
  onTaskSelect?: (taskId: string) => void;
}

interface RelationSectionProps {
  title: string;
  icon: React.ReactNode;
  taskIds: string[];
  emptyMessage: string;
  onTaskSelect?: (taskId: string) => void;
}

/**
 * Truncate task ID for display
 */
function truncateId(id: string): string {
  return id.slice(0, 6);
}

/**
 * Clickable task ID link
 */
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
      className="inline-flex items-center rounded bg-bg-tertiary px-2 py-1 font-mono text-xs text-text-secondary transition-colors hover:bg-primary/10 hover:text-primary focus:outline-none focus:ring-2 focus:ring-border-focus"
      title={`View task ${taskId}`}
    >
      {truncateId(taskId)}
    </button>
  );
}

/**
 * Section for displaying a group of related tasks
 */
function RelationSection({
  title,
  icon,
  taskIds,
  emptyMessage,
  onTaskSelect,
}: RelationSectionProps) {
  return (
    <div className="border-b border-border pb-3 last:border-b-0 last:pb-0">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-text-muted">{icon}</span>
        <span className="text-sm font-medium text-text-primary">{title}</span>
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted">
          {taskIds.length}
        </span>
      </div>
      {taskIds.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {taskIds.map((id) => (
            <TaskLink key={id} taskId={id} onClick={onTaskSelect} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-text-muted">{emptyMessage}</p>
      )}
    </div>
  );
}

/**
 * TaskRelations displays the hierarchical and dependency relationships of a task.
 * Shows parent, children, blockers (depends_on), and dependents (blocks).
 */
export function TaskRelations({
  parentId,
  childrenIds,
  dependsOnIds,
  dependentIds,
  onTaskSelect,
}: TaskRelationsProps) {
  return (
    <div className="space-y-4 p-4">
      {/* Parent */}
      <div className="border-b border-border pb-3">
        <div className="mb-2 flex items-center gap-2">
          <svg className="h-4 w-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
          <span className="text-sm font-medium text-text-primary">Parent</span>
        </div>
        {parentId ? (
          <TaskLink taskId={parentId} onClick={onTaskSelect} />
        ) : (
          <p className="text-xs text-text-muted">No parent (root task)</p>
        )}
      </div>

      {/* Children */}
      <RelationSection
        title="Children"
        icon={
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        }
        taskIds={childrenIds}
        emptyMessage="No child tasks"
        onTaskSelect={onTaskSelect}
      />

      {/* Blocked by (depends_on) */}
      <RelationSection
        title="Blocked By"
        icon={
          <svg className="h-4 w-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        }
        taskIds={dependsOnIds}
        emptyMessage="No blockers"
        onTaskSelect={onTaskSelect}
      />

      {/* Blocks (dependents) */}
      <RelationSection
        title="Blocks"
        icon={
          <svg className="h-4 w-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        }
        taskIds={dependentIds}
        emptyMessage="No dependent tasks"
        onTaskSelect={onTaskSelect}
      />
    </div>
  );
}
