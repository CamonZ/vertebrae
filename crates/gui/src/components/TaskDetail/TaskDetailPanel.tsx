import { useState } from 'react';
import type { TaskWithRelations, TaskStatus, TaskLevel, TaskPriority } from '../../bindings';
import { useTask } from '../../hooks/useTask';
import { TaskSections } from './TaskSections';
import { TaskCodeRefs } from './TaskCodeRefs';
import { TaskRelations } from './TaskRelations';

interface TaskDetailPanelProps {
  taskId: string | null;
  onClose?: () => void;
  onTaskSelect?: (taskId: string) => void;
}

type TabId = 'details' | 'sections' | 'code_refs' | 'relations';

interface Tab {
  id: TabId;
  label: string;
}

const TABS: Tab[] = [
  { id: 'details', label: 'Details' },
  { id: 'sections', label: 'Sections' },
  { id: 'code_refs', label: 'Code Refs' },
  { id: 'relations', label: 'Relations' },
];

/**
 * Format status for display
 */
function formatStatus(status: TaskStatus): string {
  switch (status) {
    case 'backlog':
      return 'Backlog';
    case 'todo':
      return 'Todo';
    case 'in_progress':
      return 'In Progress';
    case 'pending_review':
      return 'Pending Review';
    case 'done':
      return 'Done';
    case 'rejected':
      return 'Rejected';
    default:
      return status;
  }
}

/**
 * Get status badge styling
 */
function getStatusStyles(status: TaskStatus): string {
  const baseStyles = 'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium';

  switch (status) {
    case 'backlog':
      return `${baseStyles} bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300`;
    case 'todo':
      return `${baseStyles} bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400`;
    case 'in_progress':
      return `${baseStyles} bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400`;
    case 'pending_review':
      return `${baseStyles} bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400`;
    case 'done':
      return `${baseStyles} bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400`;
    case 'rejected':
      return `${baseStyles} bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400`;
    default:
      return `${baseStyles} bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300`;
  }
}

/**
 * Format level for display
 */
function formatLevel(level: TaskLevel): string {
  switch (level) {
    case 'epic':
      return 'Epic';
    case 'ticket':
      return 'Ticket';
    case 'task':
      return 'Task';
    default:
      return level;
  }
}

/**
 * Get level badge styling
 */
function getLevelStyles(level: TaskLevel): string {
  const baseStyles = 'inline-flex items-center rounded px-2 py-1 text-xs font-medium';

  switch (level) {
    case 'epic':
      return `${baseStyles} bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400`;
    case 'ticket':
      return `${baseStyles} bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400`;
    case 'task':
      return `${baseStyles} bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300`;
    default:
      return `${baseStyles} bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300`;
  }
}

/**
 * Format priority for display
 */
function formatPriority(priority: TaskPriority | null): string {
  if (!priority) return 'None';

  switch (priority) {
    case 'critical':
      return 'Critical';
    case 'high':
      return 'High';
    case 'medium':
      return 'Medium';
    case 'low':
      return 'Low';
    default:
      return priority;
  }
}

/**
 * Get priority badge styling
 */
function getPriorityStyles(priority: TaskPriority | null): string {
  if (!priority) return '';

  const baseStyles = 'inline-flex items-center rounded px-2 py-1 text-xs font-medium';

  switch (priority) {
    case 'critical':
      return `${baseStyles} bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400`;
    case 'high':
      return `${baseStyles} bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400`;
    case 'medium':
      return `${baseStyles} bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400`;
    case 'low':
      return `${baseStyles} bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400`;
    default:
      return '';
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
      year: 'numeric',
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
 * Detail row component for displaying label-value pairs
 */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between py-2">
      <span className="text-sm text-text-muted">{label}</span>
      <span className="text-sm text-text-primary">{children}</span>
    </div>
  );
}

/**
 * Task details tab content
 */
function TaskDetailsTab({ taskData }: { taskData: TaskWithRelations }) {
  const { task } = taskData;

  return (
    <div className="divide-y divide-border">
      {/* Basic Info */}
      <div className="p-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Basic Info
        </h3>
        <div className="space-y-1">
          <DetailRow label="ID">
            <code className="font-mono text-xs">{task.id?.slice(0, 6) ?? '-'}</code>
          </DetailRow>
          <DetailRow label="Level">
            <span className={getLevelStyles(task.level)}>{formatLevel(task.level)}</span>
          </DetailRow>
          <DetailRow label="Status">
            <span className={getStatusStyles(task.status)}>{formatStatus(task.status)}</span>
          </DetailRow>
          <DetailRow label="Priority">
            {task.priority ? (
              <span className={getPriorityStyles(task.priority)}>
                {formatPriority(task.priority)}
              </span>
            ) : (
              <span className="text-text-muted">-</span>
            )}
          </DetailRow>
        </div>
      </div>

      {/* Description */}
      {task.description && (
        <div className="p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Description
          </h3>
          <p className="whitespace-pre-wrap text-sm text-text-secondary">{task.description}</p>
        </div>
      )}

      {/* Tags */}
      {task.tags.length > 0 && (
        <div className="p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Tags
          </h3>
          <div className="flex flex-wrap gap-2">
            {task.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Timestamps */}
      <div className="p-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Timestamps
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

      {/* Review Status */}
      {task.needs_human_review && (
        <div className="p-4">
          <div className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 dark:bg-amber-900/20">
            <svg
              className="h-4 w-4 text-amber-600 dark:text-amber-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
              />
            </svg>
            <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
              Needs Human Review
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * TaskDetailPanel displays comprehensive task information in a side panel.
 * Fetches task data using the useTask hook and organizes content into tabs.
 */
export function TaskDetailPanel({ taskId, onClose, onTaskSelect }: TaskDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('details');
  const { task: taskData, isLoading, error } = useTask(taskId);

  // Don't render if no task is selected
  if (!taskId) {
    return null;
  }

  return (
    <div className="flex h-full w-80 flex-col border-l border-border bg-bg-primary lg:w-96">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-primary">Task Details</h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:bg-bg-tertiary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-border-focus"
            aria-label="Close panel"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <svg
              className="h-8 w-8 animate-spin text-primary"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <p className="text-sm text-text-muted">Loading task...</p>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="text-center">
            <svg
              className="mx-auto h-10 w-10 text-red-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        </div>
      )}

      {/* Content */}
      {taskData && !isLoading && !error && (
        <>
          {/* Task title */}
          <div className="border-b border-border px-4 py-3">
            <h3 className="font-medium text-text-primary">{taskData.task.title}</h3>
          </div>

          {/* Tabs */}
          <div className="border-b border-border">
            <nav className="flex" aria-label="Task detail tabs">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex-1 px-3 py-2 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-border-focus ${
                    activeTab === tab.id
                      ? 'border-b-2 border-primary text-primary'
                      : 'text-text-muted hover:text-text-primary'
                  }`}
                  aria-selected={activeTab === tab.id}
                  role="tab"
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-auto">
            {activeTab === 'details' && <TaskDetailsTab taskData={taskData} />}
            {activeTab === 'sections' && <TaskSections sections={taskData.task.sections} />}
            {activeTab === 'code_refs' && <TaskCodeRefs codeRefs={taskData.task.code_refs} />}
            {activeTab === 'relations' && (
              <TaskRelations
                parentId={taskData.parent_id}
                childrenIds={taskData.children_ids}
                dependsOnIds={taskData.depends_on_ids}
                dependentIds={taskData.dependent_ids}
                onTaskSelect={onTaskSelect}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
