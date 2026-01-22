'use client';

import { useState, useEffect, useMemo } from 'react';
import { commands } from '../../bindings';

interface TaskRelationsProps {
  taskId?: string;
  parentId: string | null;
  childrenIds: string[];
  dependsOnIds: string[];
  dependentIds: string[];
  onTaskSelect?: (taskId: string) => void;
  onRelationshipChange?: () => void;
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
      className="inline-flex items-center rounded bg-bg-tertiary px-2 py-1 font-mono text-xs text-text-secondary transition-colors hover:bg-primary/10 hover:text-primary focus:outline-none focus:ring-2 focus:ring-border-focus cursor-pointer"
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
 * TaskLister state hook for fetching available tasks
 */
interface TaskOption {
  id: string;
  title: string;
}

/**
 * Parent Picker Component
 */
function ParentPicker({
  taskId,
  currentParentId,
  onParentChange,
  onCancel,
}: {
  taskId: string;
  currentParentId: string | null;
  onParentChange: (parentId: string | null) => void;
  onCancel: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [availableTasks, setAvailableTasks] = useState<TaskOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchTasks = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const tasks = await commands.listTasks(null);
        // Filter out current task and only show root tasks and tasks that are not descendants
        // For now, show all tasks except the current one
        const filtered = tasks.filter((t) => t.id !== taskId);
        setAvailableTasks(filtered);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch tasks');
      } finally {
        setIsLoading(false);
      }
    };
    fetchTasks();
  }, [taskId]);

  const filteredTasks = useMemo(() => {
    return availableTasks.filter((task) =>
      task.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      task.id.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [availableTasks, searchQuery]);

  return (
    <div className="space-y-2">
      <input
        type="text"
        placeholder="Search tasks..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className="w-full rounded border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
      />

      {error && (
        <div className="rounded bg-error/10 p-2 text-xs text-error">{error}</div>
      )}

      {isLoading ? (
        <div className="text-center text-xs text-text-muted py-4">Loading tasks...</div>
      ) : filteredTasks.length === 0 ? (
        <div className="text-center text-xs text-text-muted py-4">No tasks found</div>
      ) : (
        <div className="max-h-48 overflow-y-auto space-y-1">
          {filteredTasks.map((task) => (
            <button
              key={task.id}
              onClick={() => onParentChange(task.id)}
              className="block w-full rounded bg-bg-tertiary px-3 py-2 text-left text-xs text-text-primary hover:bg-primary/10 hover:text-primary transition-colors cursor-pointer"
            >
              <div className="font-mono text-[10px] text-text-muted">{truncateId(task.id)}</div>
              <div className="truncate">{task.title}</div>
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        {currentParentId && (
          <button
            onClick={() => onParentChange(null)}
            className="flex-1 rounded bg-error/10 px-3 py-2 text-xs font-medium text-error hover:bg-error/20 transition-colors cursor-pointer"
          >
            Remove Parent
          </button>
        )}
        <button
          onClick={onCancel}
          className="flex-1 rounded border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary transition-colors cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Dependency Picker Component (Multi-select with cycle validation)
 */
function DependencyPicker({
  taskId,
  currentDependencies,
  onDependenciesChange,
  onCancel,
}: {
  taskId: string;
  currentDependencies: string[];
  onDependenciesChange: (dependencyIds: string[]) => void;
  onCancel: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [availableTasks, setAvailableTasks] = useState<TaskOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDeps, setSelectedDeps] = useState<string[]>(currentDependencies);

  useEffect(() => {
    const fetchTasks = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const tasks = await commands.listTasks(null);
        // Filter out current task
        const filtered = tasks.filter((t) => t.id !== taskId);
        setAvailableTasks(filtered);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch tasks');
      } finally {
        setIsLoading(false);
      }
    };
    fetchTasks();
  }, [taskId]);

  const filteredTasks = useMemo(() => {
    return availableTasks.filter((task) =>
      task.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      task.id.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [availableTasks, searchQuery]);

  const toggleDependency = (taskId: string) => {
    setSelectedDeps((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    );
  };

  return (
    <div className="space-y-2">
      <input
        type="text"
        placeholder="Search tasks..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className="w-full rounded border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
      />

      {error && (
        <div className="rounded bg-error/10 p-2 text-xs text-error">{error}</div>
      )}

      {isLoading ? (
        <div className="text-center text-xs text-text-muted py-4">Loading tasks...</div>
      ) : filteredTasks.length === 0 ? (
        <div className="text-center text-xs text-text-muted py-4">No tasks found</div>
      ) : (
        <div className="max-h-48 overflow-y-auto space-y-1">
          {filteredTasks.map((task) => (
            <label
              key={task.id}
              className="flex items-start gap-2 rounded bg-bg-tertiary px-3 py-2 cursor-pointer hover:bg-primary/10 transition-colors"
            >
              <input
                type="checkbox"
                checked={selectedDeps.includes(task.id)}
                onChange={() => toggleDependency(task.id)}
                className="mt-0.5 rounded border-border cursor-pointer"
              />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-[10px] text-text-muted">{truncateId(task.id)}</div>
                <div className="truncate text-xs text-text-primary">{task.title}</div>
              </div>
            </label>
          ))}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          onClick={() => onDependenciesChange(selectedDeps)}
          className="flex-1 rounded bg-primary/10 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/20 transition-colors cursor-pointer"
        >
          Apply
        </button>
        <button
          onClick={onCancel}
          className="flex-1 rounded border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary transition-colors cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * TaskRelations displays the hierarchical and dependency relationships of a task.
 * Shows parent, children, blockers (depends_on), and dependents (blocks).
 * Includes editing UI for parent and dependencies.
 */
export function TaskRelations({
  taskId,
  parentId,
  childrenIds,
  dependsOnIds,
  dependentIds,
  onTaskSelect,
  onRelationshipChange,
}: TaskRelationsProps) {
  const [isEditingParent, setIsEditingParent] = useState(false);
  const [isEditingDeps, setIsEditingDeps] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleParentChange = async (newParentId: string | null) => {
    if (!taskId) return;

    setIsSaving(true);
    setError(null);

    try {
      if (newParentId === null) {
        await commands.removeParent(taskId);
      } else {
        await commands.setParent(taskId, newParentId);
      }
      setIsEditingParent(false);
      onRelationshipChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update parent');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDependenciesChange = async (newDependencyIds: string[]) => {
    if (!taskId) return;

    setIsSaving(true);
    setError(null);

    try {
      // Remove dependencies that are no longer selected
      for (const depId of dependsOnIds) {
        if (!newDependencyIds.includes(depId)) {
          await commands.removeDependency(taskId, depId);
        }
      }

      // Add new dependencies
      for (const depId of newDependencyIds) {
        if (!dependsOnIds.includes(depId)) {
          await commands.addDependency(taskId, depId);
        }
      }

      setIsEditingDeps(false);
      onRelationshipChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update dependencies');
    } finally {
      setIsSaving(false);
    }
  };

  if (!taskId) {
    return <div className="p-4 text-xs text-text-muted">No task selected</div>;
  }

  return (
    <div className="space-y-4 p-4">
      {/* Error message */}
      {error && (
        <div className="rounded bg-error/10 p-3 text-xs text-error">
          <div className="font-medium">Error:</div>
          <div>{error}</div>
        </div>
      )}

      {/* Parent */}
      <div className="border-b border-border pb-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
            <span className="text-sm font-medium text-text-primary">Parent</span>
          </div>
          {!isEditingParent && (
            <button
              onClick={() => setIsEditingParent(true)}
              disabled={isSaving}
              className="rounded bg-bg-tertiary px-2 py-1 text-xs font-medium text-text-secondary hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-50"
            >
              Edit
            </button>
          )}
        </div>

        {isEditingParent ? (
          <ParentPicker
            taskId={taskId}
            currentParentId={parentId}
            onParentChange={handleParentChange}
            onCancel={() => setIsEditingParent(false)}
          />
        ) : parentId ? (
          <TaskLink taskId={parentId} onClick={onTaskSelect} />
        ) : (
          <p className="text-xs text-text-muted">No parent (root task)</p>
        )}
      </div>

      {/* Children (read-only) */}
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
      <div className="border-b border-border pb-3 last:border-b-0 last:pb-0">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="text-sm font-medium text-text-primary">Blocked By</span>
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted">
              {dependsOnIds.length}
            </span>
          </div>
          {!isEditingDeps && (
            <button
              onClick={() => setIsEditingDeps(true)}
              disabled={isSaving}
              className="rounded bg-bg-tertiary px-2 py-1 text-xs font-medium text-text-secondary hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-50"
            >
              Edit
            </button>
          )}
        </div>

        {isEditingDeps ? (
          <DependencyPicker
            taskId={taskId}
            currentDependencies={dependsOnIds}
            onDependenciesChange={handleDependenciesChange}
            onCancel={() => setIsEditingDeps(false)}
          />
        ) : dependsOnIds.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {dependsOnIds.map((id) => (
              <TaskLink key={id} taskId={id} onClick={onTaskSelect} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-text-muted">No blockers</p>
        )}
      </div>

      {/* Blocks (dependents - read-only) */}
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
