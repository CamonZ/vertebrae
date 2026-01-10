import type { TaskSummary, TaskStatus, TaskLevel, TaskPriority } from '../../bindings';

interface TaskRowProps {
  task: TaskSummary;
  isSelected?: boolean;
  onClick?: (task: TaskSummary) => void;
}

/**
 * Get status badge styling based on task status
 */
function getStatusStyles(status: TaskStatus): string {
  const baseStyles = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';

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
      return 'Review';
    case 'done':
      return 'Done';
    case 'rejected':
      return 'Rejected';
    default:
      return status;
  }
}

/**
 * Get level indicator styling
 */
function getLevelStyles(level: TaskLevel): string {
  const baseStyles = 'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium';

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
 * Get priority indicator styling
 */
function getPriorityStyles(priority: TaskPriority | null): string {
  if (!priority) return '';

  const baseStyles = 'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium';

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
 * Format priority for display
 */
function formatPriority(priority: TaskPriority | null): string {
  if (!priority) return '-';

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
 * Truncate task ID for display (show first 6 characters)
 */
function truncateId(id: string): string {
  return id.slice(0, 6);
}

/**
 * TaskRow component displays a single task in the task list table.
 * Shows task ID, title, level, status, and priority with appropriate styling.
 */
export function TaskRow({ task, isSelected = false, onClick }: TaskRowProps) {
  const handleClick = () => {
    onClick?.(task);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.(task);
    }
  };

  return (
    <tr
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="row"
      aria-selected={isSelected}
      className={`cursor-pointer border-b border-border transition-colors hover:bg-bg-tertiary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-border-focus ${
        isSelected ? 'bg-primary/5' : ''
      }`}
    >
      <td className="whitespace-nowrap px-4 py-3 font-mono text-sm text-text-muted">
        {truncateId(task.id)}
      </td>
      <td className="max-w-md truncate px-4 py-3 text-sm font-medium text-text-primary">
        {task.title}
        {task.needs_human_review && (
          <span
            className="ml-2 inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
            title="Needs human review"
          >
            Review
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-sm">
        <span className={getLevelStyles(task.level)}>
          {formatLevel(task.level)}
        </span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-sm">
        <span className={getStatusStyles(task.status)}>
          {formatStatus(task.status)}
        </span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-sm">
        {task.priority ? (
          <span className={getPriorityStyles(task.priority)}>
            {formatPriority(task.priority)}
          </span>
        ) : (
          <span className="text-text-muted">-</span>
        )}
      </td>
    </tr>
  );
}
