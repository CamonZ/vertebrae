import { useState, useEffect, useRef, useCallback } from 'react';
import type { TaskWithRelations, TaskLevel, TaskPriority, TaskChangedEvent } from '../../bindings';
import { commands, events } from '../../bindings';
import { useTask } from '../../hooks/useTask';
import { TaskSections } from './TaskSections';
import { TaskCodeRefs } from './TaskCodeRefs';
import { TaskRelations } from './TaskRelations';
import { ExecutionHistory } from './ExecutionHistory';
import { ResizablePanel } from '../ResizablePanel';

/** Debounce delay in milliseconds for batching rapid events */
const DEBOUNCE_MS = 100;

interface TaskDetailPanelProps {
  taskId: string | null;
  onClose?: () => void;
  onTaskSelect?: (taskId: string) => void;
}

type TabId = 'details' | 'sections' | 'code_refs' | 'relations' | 'history';

interface Tab {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

const TABS: Tab[] = [
  {
    id: 'details',
    label: 'Details',
    icon: (
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'sections',
    label: 'Sections',
    icon: (
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h7" />
      </svg>
    ),
  },
  {
    id: 'code_refs',
    label: 'Code',
    icon: (
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
      </svg>
    ),
  },
  {
    id: 'relations',
    label: 'Graph',
    icon: (
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
      </svg>
    ),
  },
  {
    id: 'history',
    label: 'History',
    icon: (
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

/**
 * Get status styling.
 * Status is now a string that can be either:
 * - A step name (e.g., 'backlog', 'in_progress', 'done')
 * - A workflow:step format (e.g., 'default:in_progress')
 */
function getStatusStyles(status: string): { bg: string; text: string; glow?: string } {
  // Extract step name from potential workflow:step format
  const stepName = status.includes(':') ? status.split(':').pop() ?? status : status;
  
  switch (stepName) {
    case 'backlog':
      return { bg: 'bg-bg-tertiary', text: 'text-text-muted' };
    case 'todo':
      return { bg: 'bg-primary/10', text: 'text-primary' };
    case 'in_progress':
      return { bg: 'bg-warning/10', text: 'text-warning', glow: 'shadow-[0_0_8px_rgba(245,158,11,0.3)]' };
    case 'pending_review':
      return { bg: 'bg-info/10', text: 'text-info' };
    case 'done':
      return { bg: 'bg-success/10', text: 'text-success' };
    case 'rejected':
      return { bg: 'bg-error/10', text: 'text-error' };
    default:
      return { bg: 'bg-bg-tertiary', text: 'text-text-muted' };
  }
}

/**
 * Get level styling
 */
function getLevelStyles(level: TaskLevel): { bg: string; text: string; border: string } {
  switch (level) {
    case 'epic':
      return { bg: 'bg-info/10', text: 'text-info', border: 'border-info/30' };
    case 'ticket':
      return { bg: 'bg-primary/10', text: 'text-primary', border: 'border-primary/30' };
    case 'task':
      return { bg: 'bg-bg-tertiary', text: 'text-text-secondary', border: 'border-border' };
    default:
      return { bg: 'bg-bg-tertiary', text: 'text-text-muted', border: 'border-border' };
  }
}

/**
 * Get priority styling
 */
function getPriorityStyles(priority: TaskPriority | null): { indicator: string; color: string } | null {
  if (!priority) return null;

  switch (priority) {
    case 'critical':
      return { indicator: '!!!', color: 'text-error' };
    case 'high':
      return { indicator: '!!', color: 'text-warning' };
    case 'medium':
      return { indicator: '!', color: 'text-text-secondary' };
    case 'low':
      return { indicator: '-', color: 'text-text-muted' };
    default:
      return null;
  }
}

/**
 * Format datetime for display
 */
function formatDateTime(isoString: string | null): string {
  if (!isoString) return '-';

  try {
    const date = new Date(isoString);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

/**
 * Detail row component
 */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      <span className="text-sm text-text-primary">{children}</span>
    </div>
  );
}

/**
 * Task details tab content
 */
function TaskDetailsTab({ taskData }: { taskData: TaskWithRelations }) {
  const { task } = taskData;
  const statusStyles = getStatusStyles(task.status);
  const levelStyles = getLevelStyles(task.level);
  const priorityStyles = getPriorityStyles(task.priority);

  return (
    <div className="divide-y divide-border">
      {/* Status Badges */}
      <div className="flex flex-wrap gap-2 p-4">
        <span className={`inline-flex items-center rounded border px-2 py-1 text-[10px] font-medium uppercase tracking-wider ${levelStyles.bg} ${levelStyles.text} ${levelStyles.border}`}>
          {task.level}
        </span>
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${statusStyles.bg} ${statusStyles.text} ${statusStyles.glow ?? ''}`}>
          {task.status.replace('_', ' ')}
        </span>
        {priorityStyles && (
          <span className={`font-mono text-sm font-bold ${priorityStyles.color}`}>
            {priorityStyles.indicator}
          </span>
        )}
      </div>

      {/* Basic Info */}
      <div className="p-4">
        <div className="space-y-1 divide-y divide-border-subtle">
          <DetailRow label="ID">
            <code className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-xs">{task.id?.slice(0, 8) ?? '-'}</code>
          </DetailRow>
        </div>
      </div>

      {/* Description */}
      {task.description && (
        <div className="p-4">
          <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Description
          </h3>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">{task.description}</p>
        </div>
      )}

      {/* Tags */}
      {task.tags.length > 0 && (
        <div className="p-4">
          <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Tags
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {task.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Timestamps */}
      <div className="p-4">
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Timeline
        </h3>
        <div className="space-y-1">
          <DetailRow label="Created">{formatDateTime(task.created_at)}</DetailRow>
          <DetailRow label="Updated">{formatDateTime(task.updated_at)}</DetailRow>
          {task.started_at && (
            <DetailRow label="Started">{formatDateTime(task.started_at)}</DetailRow>
          )}
          {task.completed_at && (
            <DetailRow label="Completed">{formatDateTime(task.completed_at)}</DetailRow>
          )}
        </div>
      </div>

      {/* Review Flag */}
      {task.needs_human_review && (
        <div className="p-4">
          <div className="flex items-center gap-3 rounded-lg border border-warning/20 bg-warning/5 px-4 py-3">
            <div className="relative">
              <svg
                className="h-5 w-5 text-warning"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-warning" />
              </span>
            </div>
            <div>
              <p className="text-sm font-medium text-warning">Needs Human Review</p>
              <p className="text-xs text-text-muted">This task requires manual verification</p>
            </div>
          </div>
        </div>
      )}

      {/* Revision Feedback Banner */}
      {task.revision_feedback && (
        <div className="p-4">
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                <svg
                  className="h-5 w-5 text-warning"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-semibold text-warning">Revision Required</h4>
                <p className="mt-1 whitespace-pre-wrap text-sm text-text-secondary">{task.revision_feedback}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Rejection Reason Banner */}
      {task.rejection_reason && (
        <div className="p-4">
          <div className="rounded-lg border border-error/30 bg-error/10 p-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                <svg
                  className="h-5 w-5 text-error"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-semibold text-error">Rejection Reason</h4>
                <p className="mt-1 whitespace-pre-wrap text-sm text-text-secondary">{task.rejection_reason}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * TaskDetailPanel displays comprehensive task information in a side panel.
 * Features neural-pathway-inspired design with glowing accents.
 * Automatically refreshes when task change events are received.
 */
export function TaskDetailPanel({ taskId, onClose, onTaskSelect }: TaskDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('details');
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const { task: taskData, isLoading, error, refetch } = useTask(taskId);

  // Track pending refetch for debouncing
  const pendingRefetch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  // Handle task change events for this specific task
  const handleTaskChanged = useCallback(
    (event: { payload: TaskChangedEvent }) => {
      const { task_id, change_type } = event.payload;

      // Only respond to events for the currently displayed task
      if (task_id !== taskId) {
        return;
      }

      console.debug(
        `[TaskDetailPanel] Received ${change_type} event for task ${task_id.slice(0, 6)}`
      );

      // For deletions, refetch immediately (will show error state)
      if (change_type === "Deleted") {
        refetchRef.current();
        return;
      }

      // Debounce updates to batch rapid changes
      if (pendingRefetch.current) {
        clearTimeout(pendingRefetch.current);
      }
      pendingRefetch.current = setTimeout(() => {
        refetchRef.current();
        pendingRefetch.current = null;
      }, DEBOUNCE_MS);
    },
    [taskId]
  );

  // Subscribe to task change events
  useEffect(() => {
    if (!taskId) {
      return;
    }

    const unlistenPromise = events.taskChangedEvent.listen(handleTaskChanged);

    return () => {
      unlistenPromise.then((unlisten) => unlisten());

      // Clear pending timeout on cleanup
      if (pendingRefetch.current) {
        clearTimeout(pendingRefetch.current);
      }
    };
  }, [taskId, handleTaskChanged]);

  // Handle running the workflow
  const handleRunWorkflow = useCallback(async () => {
    if (!taskId || isRunning) return;
    
    setIsRunning(true);
    setRunError(null);
    
    try {
      const result = await commands.runWorkflow(taskId);
      if (result.status === 'error') {
        setRunError(result.error.message);
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to run workflow');
    } finally {
      setIsRunning(false);
    }
  }, [taskId, isRunning]);

  if (!taskId) {
    return null;
  }

  return (
    <ResizablePanel
      storageKey="task-detail-panel-width"
      glowColor="from-primary/0 via-primary/30 to-primary/0"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-mono text-xs font-medium uppercase tracking-wider text-text-muted">Task Details</h2>
        <div className="flex items-center gap-2">
          {/* Run Workflow Button - only show if task has a workflow */}
          {taskData?.task.workflow_id && (
            <button
              type="button"
              onClick={handleRunWorkflow}
              disabled={isRunning}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                isRunning
                  ? 'cursor-not-allowed bg-primary/20 text-primary/50'
                  : 'bg-primary/10 text-primary hover:bg-primary/20 hover:shadow-glow-sm'
              }`}
              aria-label={isRunning ? 'Running workflow...' : 'Run workflow'}
              title={isRunning ? 'Running workflow...' : 'Run workflow for this task'}
            >
              {isRunning ? (
                <>
                  <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span>Running...</span>
                </>
              ) : (
                <>
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>Run</span>
                </>
              )}
            </button>
          )}
          {/* Edit Button */}
          <button
            type="button"
            onClick={() => {}}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary bg-primary/10 text-primary hover:bg-primary/20 hover:shadow-glow-sm"
            aria-label="Edit task"
            title="Edit this task"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            <span>Edit</span>
          </button>
          {/* Delete Button */}
          <button
            type="button"
            onClick={() => {}}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-error bg-error/10 text-error hover:bg-error/20 hover:shadow-glow-sm"
            aria-label="Delete task"
            title="Delete this task"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            <span>Delete</span>
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Close panel"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Run error banner */}
      {runError && (
        <div className="border-b border-error/20 bg-error/5 px-4 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-error">{runError}</p>
            <button
              type="button"
              onClick={() => setRunError(null)}
              className="rounded p-0.5 text-error/60 hover:bg-error/10 hover:text-error"
              aria-label="Dismiss error"
            >
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="relative">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
              <div className="absolute inset-0 animate-pulse rounded-full bg-primary/10" />
            </div>
            <p className="text-xs text-text-muted">Loading task...</p>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="text-center">
            <div className="relative mx-auto mb-3 inline-block">
              <div className="absolute inset-0 rounded-full bg-error/20 blur-lg" />
              <svg className="relative h-10 w-10 text-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <p className="mb-2 text-sm font-medium text-text-primary">Failed to load task</p>
            <p className="rounded-lg border border-error/20 bg-error/5 px-3 py-2 font-mono text-xs text-error">{error}</p>
          </div>
        </div>
      )}

      {/* Content */}
      {taskData && !isLoading && !error && (
        <>
          {/* Task title */}
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-medium leading-snug text-text-primary">{taskData.task.title}</h3>
          </div>

          {/* Tabs */}
          <div className="border-b border-border">
            <nav className="flex" aria-label="Task detail tabs">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`relative flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${
                    activeTab === tab.id
                      ? 'text-primary'
                      : 'text-text-muted hover:text-text-secondary'
                  }`}
                  aria-selected={activeTab === tab.id}
                  role="tab"
                >
                  {tab.icon}
                  <span className="hidden sm:inline">{tab.label}</span>
                  {activeTab === tab.id && (
                    <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-primary shadow-glow-sm" />
                  )}
                </button>
              ))}
            </nav>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-auto">
            {activeTab === 'details' && <TaskDetailsTab taskData={taskData} />}
            {activeTab === 'sections' && <TaskSections sections={taskData.task.sections} taskId={taskData.task.id} onSectionsChanged={refetch} />}
            {activeTab === 'code_refs' && <TaskCodeRefs codeRefs={taskData.task.code_refs} />}
            {activeTab === 'relations' && (
              <TaskRelations
                taskId={taskData.task.id}
                parentId={taskData.parent_id}
                childrenIds={taskData.children_ids}
                dependsOnIds={taskData.depends_on_ids}
                dependentIds={taskData.dependent_ids}
                onTaskSelect={onTaskSelect}
                onRelationshipChange={refetch}
              />
            )}
            {activeTab === 'history' && taskData.task.id && (
              <ExecutionHistory taskId={taskData.task.id} />
            )}
          </div>
        </>
      )}
    </ResizablePanel>
  );
}
