import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { Task } from '../../bindings';

export type TaskExecutionStatus = 'waiting' | 'in_progress' | 'completed' | 'failed';

/**
 * Data passed to TaskNode
 */
export type TaskNodeData = {
  task: Task;
  status: TaskExecutionStatus;
  error?: string;
  hasBlockers: boolean;
  isBlocking: boolean;
};

export type TaskNodeType = Node<TaskNodeData, 'taskNode'>;

/**
 * Custom node component for displaying a task in the execution graph.
 * Shows task title, ID, execution status, and dependency indicators.
 */
function TaskNodeComponent({ data, selected }: NodeProps<TaskNodeType>) {
  const { task, status, error, hasBlockers, isBlocking } = data;

  const getStatusColor = (status: TaskExecutionStatus) => {
    switch (status) {
      case 'in_progress':
        return 'border-accent bg-accent/10';
      case 'completed':
        return 'border-success bg-success/10';
      case 'failed':
        return 'border-error bg-error/10';
      default:
        return 'border-border bg-bg-tertiary';
    }
  };

  const getStatusIcon = (status: TaskExecutionStatus) => {
    switch (status) {
      case 'in_progress':
        return '⟳';
      case 'completed':
        return '✓';
      case 'failed':
        return '✕';
      default:
        return '○';
    }
  };

  return (
    <div
      className={`relative min-w-[180px] rounded-lg border p-3 transition-all duration-200 ${getStatusColor(
        status
      )} ${
        selected
          ? 'shadow-glow-sm ring-2 ring-primary'
          : 'hover:border-primary/50 hover:shadow-glow-sm'
      }`}
      style={{
        // Add box-shadow to create 3D stacked appearance
        boxShadow: '3px 3px 0px rgba(0, 0, 0, 0.3), 4px 4px 8px rgba(0, 0, 0, 0.2)',
      }}
    >
      {/* Input handles for dependencies */}
      {hasBlockers && (
        <Handle
          type="target"
          position={Position.Left}
          className="!-left-1.5 !h-2.5 !w-2.5 !rounded-full !border-2 !border-warning !bg-bg-primary"
        />
      )}

      {/* Task header */}
      <div className="mb-2 flex items-start gap-2">
        <span
          className={`flex-shrink-0 text-sm font-bold ${
            status === 'in_progress'
              ? 'animate-spin text-accent'
              : status === 'completed'
                ? 'text-success'
                : status === 'failed'
                  ? 'text-error'
                  : 'text-text-muted'
          }`}
        >
          {getStatusIcon(status)}
        </span>
        <div className="flex-1 min-w-0">
          <p className="truncate text-sm font-medium text-text-primary" title={task.title}>
            {task.title}
          </p>
          <code className="block truncate font-mono text-xs text-text-muted">
            {(task.id ?? '').slice(0, 8)}
          </code>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <p className="text-xs text-error truncate" title={error}>
          {error}
        </p>
      )}

      {/* Dependency indicators */}
      {(hasBlockers || isBlocking) && (
        <div className="mt-2 flex gap-1 text-[10px] text-text-muted">
          {hasBlockers && (
            <span className="inline-flex items-center gap-0.5 rounded border border-warning/30 bg-warning/5 px-1.5 py-0.5">
              ↙ blocked
            </span>
          )}
          {isBlocking && (
            <span className="inline-flex items-center gap-0.5 rounded border border-info/30 bg-info/5 px-1.5 py-0.5">
              ↗ blocks
            </span>
          )}
        </div>
      )}

      {/* Output handles for blocking relationships */}
      {isBlocking && (
        <Handle
          type="source"
          position={Position.Right}
          className="!-right-1.5 !h-2.5 !w-2.5 !rounded-full !border-2 !border-info !bg-bg-primary"
        />
      )}
    </div>
  );
}

/**
 * Memoized TaskNode to prevent unnecessary re-renders
 */
export const TaskNode = memo(TaskNodeComponent);
