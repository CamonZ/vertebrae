'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { commands } from '../../bindings';
import { NavigableReference, ScanIdentifier } from '../shared/EntityId';

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
 * Task option for pickers
 */
interface TaskOption {
  id: string;
  title: string;
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
  const handleKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
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
      className="inline-flex items-center rounded bg-bg-tertiary px-2 py-1 font-mono text-xs text-text-secondary transition-colors hover:bg-primary/10 hover:text-primary focus:outline-none focus:ring-2 focus:ring-border-focus cursor-pointer"
      title={`View task ${taskId}`}
    >
      <NavigableReference id={taskId} kind="task" testId="task-relation-id" />
    </span>
  );
}

/**
 * Section for displaying a group of related tasks (read-only)
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
 * Hook to fetch available tasks
 */
function useAvailableTasks(taskId: string) {
  const [availableTasks, setAvailableTasks] = useState<TaskOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchTasks = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const result = await commands.listTasks(null);
        if (result.status === 'ok') {
          // Filter out current task
          const filtered = result.data.filter((t) => t.id !== taskId);
          setAvailableTasks(filtered);
        } else {
          setError(result.error.message);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch tasks');
      } finally {
        setIsLoading(false);
      }
    };
    fetchTasks();
  }, [taskId]);

  return { availableTasks, isLoading, error };
}

/**
 * Parent Picker Component - follows inline edit patterns
 */
function ParentPicker({
  taskId,
  currentParentId,
  onParentChange,
  onCancel,
  onRemove,
}: {
  taskId: string;
  currentParentId: string | null;
  onParentChange: (parentId: string) => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const { availableTasks, isLoading, error } = useAvailableTasks(taskId);

  const filteredTasks = useMemo(() => {
    return availableTasks.filter(
      (task) =>
        task.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        task.id.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [availableTasks, searchQuery]);

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        {/* Warning dot indicator */}
        <span className="mt-2.5 h-2 w-2 flex-shrink-0 rounded-full bg-warning" />
        
        <div className="flex-1 min-w-0 space-y-2">
          <input
            type="text"
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
            className="w-full rounded border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
          />

          {error && (
            <div className="rounded bg-error/10 p-2 text-xs text-error">{error}</div>
          )}

          {isLoading ? (
            <div className="text-center text-xs text-text-muted py-4">Loading tasks...</div>
          ) : filteredTasks.length === 0 ? (
            <div className="text-center text-xs text-text-muted py-4">No tasks found</div>
          ) : (
            <div className="max-h-48 overflow-y-auto space-y-1 rounded border border-border bg-bg-tertiary p-1">
              {filteredTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onParentChange(task.id)}
                  className="block w-full rounded px-3 py-2 text-left text-xs text-text-primary hover:bg-primary/10 hover:text-primary transition-colors cursor-pointer"
                >
                  <ScanIdentifier
                    id={task.id}
                    kind="task"
                    className="text-2xs"
                    testId="parent-picker-task-id"
                  />
                  <div className="truncate">{task.title}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex-shrink-0 flex items-center gap-1 mt-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded text-text-muted hover:bg-bg-tertiary hover:text-text-primary transition-colors cursor-pointer"
            title="Cancel (Esc)"
            aria-label="Cancel"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          {currentParentId && (
            <button
              type="button"
              onClick={onRemove}
              className="p-1.5 rounded text-text-muted hover:bg-error/10 hover:text-error transition-colors cursor-pointer"
              title="Remove parent"
              aria-label="Remove parent"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Dependency Picker Component - follows inline edit patterns
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
  const [selectedDeps, setSelectedDeps] = useState<string[]>(currentDependencies);
  const { availableTasks, isLoading, error } = useAvailableTasks(taskId);

  const filteredTasks = useMemo(() => {
    return availableTasks.filter(
      (task) =>
        task.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        task.id.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [availableTasks, searchQuery]);

  const toggleDependency = useCallback((depTaskId: string) => {
    setSelectedDeps((prev) =>
      prev.includes(depTaskId) ? prev.filter((id) => id !== depTaskId) : [...prev, depTaskId]
    );
  }, []);

  const hasChanges = useMemo(() => {
    if (selectedDeps.length !== currentDependencies.length) return true;
    return !selectedDeps.every((id) => currentDependencies.includes(id));
  }, [selectedDeps, currentDependencies]);

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        {/* Warning dot indicator */}
        <span className="mt-2.5 h-2 w-2 flex-shrink-0 rounded-full bg-warning" />
        
        <div className="flex-1 min-w-0 space-y-2">
          <input
            type="text"
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
            className="w-full rounded border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
          />

          {error && (
            <div className="rounded bg-error/10 p-2 text-xs text-error">{error}</div>
          )}

          {isLoading ? (
            <div className="text-center text-xs text-text-muted py-4">Loading tasks...</div>
          ) : filteredTasks.length === 0 ? (
            <div className="text-center text-xs text-text-muted py-4">No tasks found</div>
          ) : (
            <div className="max-h-48 overflow-y-auto space-y-1 rounded border border-border bg-bg-tertiary p-1">
              {filteredTasks.map((task) => (
                <label
                  key={task.id}
                  className="flex items-start gap-2 rounded px-3 py-2 cursor-pointer hover:bg-primary/10 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selectedDeps.includes(task.id)}
                    onChange={() => toggleDependency(task.id)}
                    className="mt-0.5 rounded border-border cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <ScanIdentifier
                      id={task.id}
                      kind="task"
                      className="text-2xs"
                      testId="dependency-picker-task-id"
                    />
                    <div className="truncate text-xs text-text-primary">{task.title}</div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex-shrink-0 flex items-center gap-1 mt-1.5">
          <button
            type="button"
            onClick={() => onDependenciesChange(selectedDeps)}
            disabled={!hasChanges}
            className="p-1.5 rounded text-warning hover:bg-warning/10 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            title="Save changes"
            aria-label="Save"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded text-text-muted hover:bg-bg-tertiary hover:text-text-primary transition-colors cursor-pointer"
            title="Cancel (Esc)"
            aria-label="Cancel"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * TaskRelations displays the hierarchical and dependency relationships of a task.
 * Shows parent, children, blockers (depends_on), and dependents (blocks).
 * Includes editing UI for parent and dependencies following inline edit patterns.
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

  const handleParentChange = useCallback(async (newParentId: string) => {
    if (!taskId) return;

    setIsSaving(true);
    setError(null);

    try {
      const result = await commands.setParent(taskId, newParentId);
      if (result.status === 'error') {
        setError(result.error.message);
        return;
      }
      setIsEditingParent(false);
      onRelationshipChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update parent');
    } finally {
      setIsSaving(false);
    }
  }, [taskId, onRelationshipChange]);

  const handleRemoveParent = useCallback(async () => {
    if (!taskId) return;

    setIsSaving(true);
    setError(null);

    try {
      const result = await commands.removeParent(taskId);
      if (result.status === 'error') {
        setError(result.error.message);
        return;
      }
      setIsEditingParent(false);
      onRelationshipChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove parent');
    } finally {
      setIsSaving(false);
    }
  }, [taskId, onRelationshipChange]);

  const handleDependenciesChange = useCallback(async (newDependencyIds: string[]) => {
    if (!taskId) return;

    setIsSaving(true);
    setError(null);

    try {
      // Remove dependencies that are no longer selected
      for (const depId of dependsOnIds) {
        if (!newDependencyIds.includes(depId)) {
          const result = await commands.removeDependency(taskId, depId);
          if (result.status === 'error') {
            setError(result.error.message);
            setIsSaving(false);
            return;
          }
        }
      }

      // Add new dependencies
      for (const depId of newDependencyIds) {
        if (!dependsOnIds.includes(depId)) {
          const result = await commands.addDependency(taskId, depId);
          if (result.status === 'error') {
            setError(result.error.message);
            setIsSaving(false);
            return;
          }
        }
      }

      setIsEditingDeps(false);
      onRelationshipChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update dependencies');
    } finally {
      setIsSaving(false);
    }
  }, [taskId, dependsOnIds, onRelationshipChange]);

  // Handle keyboard escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isEditingParent) setIsEditingParent(false);
        if (isEditingDeps) setIsEditingDeps(false);
      }
    };
    
    if (isEditingParent || isEditingDeps) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isEditingParent, isEditingDeps]);

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
        <div className="mb-2 flex items-center gap-2">
          <svg className="h-4 w-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
          <span className="text-sm font-medium text-text-primary">Parent</span>
        </div>

        {isEditingParent ? (
          <ParentPicker
            taskId={taskId}
            currentParentId={parentId}
            onParentChange={handleParentChange}
            onCancel={() => setIsEditingParent(false)}
            onRemove={handleRemoveParent}
          />
        ) : (
          <div
            onClick={() => !isSaving && setIsEditingParent(true)}
            className="cursor-pointer rounded p-2 hover:bg-bg-hover transition-colors"
            title="Click to edit"
          >
            {parentId ? (
              <TaskLink taskId={parentId} onClick={onTaskSelect} />
            ) : (
              <p className="text-xs text-text-muted italic">No parent (root task)</p>
            )}
          </div>
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
        <div className="mb-2 flex items-center gap-2">
          <svg className="h-4 w-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-sm font-medium text-text-primary">Blocked By</span>
          <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted">
            {dependsOnIds.length}
          </span>
        </div>

        {isEditingDeps ? (
          <DependencyPicker
            taskId={taskId}
            currentDependencies={dependsOnIds}
            onDependenciesChange={handleDependenciesChange}
            onCancel={() => setIsEditingDeps(false)}
          />
        ) : (
          <div
            onClick={() => !isSaving && setIsEditingDeps(true)}
            className="cursor-pointer rounded p-2 hover:bg-bg-hover transition-colors"
            title="Click to edit"
          >
            {dependsOnIds.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {dependsOnIds.map((id) => (
                  <TaskLink key={id} taskId={id} onClick={onTaskSelect} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-muted italic">No blockers</p>
            )}
          </div>
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
