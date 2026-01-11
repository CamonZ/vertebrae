import type { TaskSummary, TaskStatus, TaskLevel, TaskPriority } from '../../bindings';

interface TaskRowProps {
  task: TaskSummary;
  isSelected?: boolean;
  onClick?: (task: TaskSummary) => void;
}

/**
 * Get status badge styling based on task status
 */
function getStatusStyles(status: TaskStatus): { bg: string; text: string; glow?: string } {
  switch (status) {
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
 * Format status for display
 */
function formatStatus(status: TaskStatus): string {
  switch (status) {
    case 'backlog':
      return 'Backlog';
    case 'todo':
      return 'Todo';
    case 'in_progress':
      return 'Active';
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
 * Get priority indicator
 */
function getPriorityIndicator(priority: TaskPriority | null): { icon: string; color: string } | null {
  if (!priority) return null;

  switch (priority) {
    case 'critical':
      return { icon: '!!!', color: 'text-error' };
    case 'high':
      return { icon: '!!', color: 'text-warning' };
    case 'medium':
      return { icon: '!', color: 'text-text-secondary' };
    case 'low':
      return { icon: '-', color: 'text-text-muted' };
    default:
      return null;
  }
}

/**
 * Truncate task ID for display (show first 6 characters)
 */
function truncateId(id: string): string {
  return id.slice(0, 6);
}

/**
 * TaskRow component displays a single task in the task list.
 * Features neural-inspired styling with glowing active states.
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

  const statusStyles = getStatusStyles(task.status);
  const levelStyles = getLevelStyles(task.level);
  const priorityIndicator = getPriorityIndicator(task.priority);
  const isActive = task.status === 'in_progress';

  return (
    <tr
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="row"
      aria-selected={isSelected}
      className={`group cursor-pointer border-b border-border transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${
        isSelected
          ? 'bg-primary/5'
          : 'hover:bg-bg-hover'
      }`}
    >
      {/* ID column */}
      <td className={`whitespace-nowrap px-4 py-3 ${isSelected ? 'border-l-2 border-primary' : 'border-l-2 border-transparent'}`}>
        <code className="font-mono text-xs text-text-muted">
          {truncateId(task.id)}
        </code>
      </td>

      {/* Title column */}
      <td className="max-w-md px-4 py-3">
        <div className="flex items-center gap-2">
          {/* Active pulse indicator */}
          {isActive && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-warning" />
            </span>
          )}
          <span className={`truncate text-sm font-medium ${isSelected ? 'text-text-primary' : 'text-text-primary group-hover:text-text-primary'}`}>
            {task.title}
          </span>
          {task.needs_human_review && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-warning">
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              Review
            </span>
          )}
        </div>
      </td>

      {/* Level column */}
      <td className="whitespace-nowrap px-4 py-3">
        <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${levelStyles.bg} ${levelStyles.text} ${levelStyles.border}`}>
          {formatLevel(task.level)}
        </span>
      </td>

      {/* Status column */}
      <td className="whitespace-nowrap px-4 py-3">
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyles.bg} ${statusStyles.text} ${statusStyles.glow ?? ''}`}>
          {formatStatus(task.status)}
        </span>
      </td>

      {/* Priority column */}
      <td className="whitespace-nowrap px-4 py-3">
        {priorityIndicator ? (
          <span className={`font-mono text-sm font-bold ${priorityIndicator.color}`}>
            {priorityIndicator.icon}
          </span>
        ) : (
          <span className="text-text-muted">-</span>
        )}
      </td>

      {/* Tags column */}
      <td className="px-4 py-3">
        {task.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {task.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary"
              >
                {tag}
              </span>
            ))}
            {task.tags.length > 3 && (
              <span className="inline-flex items-center rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-muted">
                +{task.tags.length - 3}
              </span>
            )}
          </div>
        ) : (
          <span className="text-text-muted">-</span>
        )}
      </td>
    </tr>
  );
}
