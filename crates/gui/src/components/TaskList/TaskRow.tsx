import type { Task, TaskLevel, TaskPriority } from '../../bindings';
import { RelativeTime } from '../RelativeTime';
import { deriveRunStateChip, getRunChipStyles } from '../../utils/runState';

interface TaskRowProps {
  task: Task;
  isSelected?: boolean;
  onClick?: (task: Task) => void;
  columnWidths?: Record<string, number>;
  hideStatus?: boolean;
}

/**
 * Get step badge styling based on step name.
 */
function getStepStyles(stepName: string | null): { bg: string; text: string; glow?: string } {
  if (!stepName) {
    return { bg: 'bg-bg-tertiary', text: 'text-text-muted' };
  }
  
  const normalizedStep = stepName.toLowerCase();
  switch (normalizedStep) {
    case 'backlog':
      return { bg: 'bg-bg-tertiary', text: 'text-text-muted' };
    case 'todo':
      return { bg: 'bg-primary/10', text: 'text-primary' };
    case 'in_progress':
    case 'in progress':
      return { bg: 'bg-warning/10', text: 'text-warning', glow: 'shadow-[0_0_8px_rgba(245,158,11,0.3)]' };
    case 'pending_review':
    case 'review':
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
 * Format step name for display.
 */
function formatStepName(stepName: string | null): string {
  if (!stepName) return '-';
  
  // Capitalize first letter and replace underscores with spaces
  return stepName.charAt(0).toUpperCase() + stepName.slice(1).replace(/_/g, ' ');
}

/**
 * Get level indicator styling
 */
function getLevelStyles(level: TaskLevel | null): { bg: string; text: string; border: string } {
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
function formatLevel(level: TaskLevel | null): string {
  switch (level) {
    case 'epic':
      return 'Epic';
    case 'ticket':
      return 'Ticket';
    case 'task':
      return 'Task';
    default:
      return level ?? 'Unknown';
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

function truncateId(id: string): string {
  return id.slice(0, 6);
}

/**
 * TaskRow component displays a single task in the task list.
 * Features neural-inspired styling with glowing active states and resizable columns.
 */
export function TaskRow({ task, isSelected = false, onClick, columnWidths = {}, hideStatus = false }: TaskRowProps) {
  const handleClick = () => {
    onClick?.(task);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.(task);
    }
  };

  const stepStyles = getStepStyles(task.step_name);
  const levelStyles = getLevelStyles(task.level);
  const priorityIndicator = getPriorityIndicator(task.priority);
  const runChip = deriveRunStateChip(task);
  const runChipStyles = runChip ? getRunChipStyles(runChip) : null;

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
      {/* Created column */}
      <td
        style={{ width: columnWidths['created'] ? `${columnWidths['created']}px` : '90px' }}
        className={`whitespace-nowrap px-2 py-3 ${isSelected ? 'border-l-2 border-primary' : 'border-l-2 border-transparent'}`}
      >
        {task.created_at ? <RelativeTime date={task.created_at} /> : <span className="text-text-muted">—</span>}
      </td>

      {/* ID column */}
      <td
        style={{ width: columnWidths['id'] ? `${columnWidths['id']}px` : '80px' }}
        className="whitespace-nowrap px-4 py-3"
      >
        <code className="font-mono text-xs text-text-muted">
          {truncateId(task.id)}
        </code>
      </td>

      {/* Title column */}
      <td
        style={{ width: columnWidths['title'] ? `${columnWidths['title']}px` : '300px' }}
        className="px-4 py-3"
      >
        <div className="flex items-center gap-2 overflow-hidden">
          {runChip && runChipStyles && (
            <span
              data-testid="task-row-run-chip"
              data-run-status={runChip.status}
              className={`w-2 h-2 shrink-0 rounded-full ${runChipStyles.dot} ${runChipStyles.pulse ? 'animate-pulse' : ''}`}
              title={`Run: ${runChip.label}`}
              aria-label={`Run state: ${runChip.label}`}
            />
          )}
          <span className={`break-words text-sm font-medium ${isSelected ? 'text-text-primary' : 'text-text-primary group-hover:text-text-primary'}`}>
            {task.title}
          </span>
          {runChip && runChipStyles && (
            <span
              data-testid="task-row-run-chip-label"
              className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${runChipStyles.bg} ${runChipStyles.text}`}
            >
              {runChip.label}
            </span>
          )}
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
      <td style={{ width: columnWidths['level'] ? `${columnWidths['level']}px` : '100px' }} className="whitespace-nowrap px-4 py-3">
        <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${levelStyles.bg} ${levelStyles.text} ${levelStyles.border}`}>
          {formatLevel(task.level)}
        </span>
      </td>

      {/* Workflow/Step column */}
      <td style={{ width: columnWidths['status'] ? `${columnWidths['status']}px` : '180px' }} className="whitespace-nowrap px-2 py-3">
        {hideStatus ? (
          <span className="text-text-muted">-</span>
        ) : (
          <div className="flex items-center gap-1.5">
            {task.workflow_name && (
              <span className="inline-flex items-center rounded border border-border bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                {task.workflow_name}
              </span>
            )}
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${stepStyles.bg} ${stepStyles.text} ${stepStyles.glow ?? ''}`}>
              {formatStepName(task.step_name)}
            </span>
          </div>
        )}
      </td>

      {/* Priority column */}
      <td style={{ width: columnWidths['priority'] ? `${columnWidths['priority']}px` : '70px' }} className="whitespace-nowrap px-2 py-3 text-center">
        {priorityIndicator ? (
          <span className={`font-mono text-sm font-bold ${priorityIndicator.color}`}>
            {priorityIndicator.icon}
          </span>
        ) : (
          <span className="text-text-muted">-</span>
        )}
      </td>

      {/* Tags column */}
      <td style={{ width: columnWidths['tags'] ? `${columnWidths['tags']}px` : '200px' }} className="px-4 py-3">
        {(task.tags ?? []).length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {(task.tags ?? []).slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary"
              >
                {tag}
              </span>
            ))}
            {(task.tags ?? []).length > 3 && (
              <span className="inline-flex items-center rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-muted">
                +{(task.tags ?? []).length - 3}
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
