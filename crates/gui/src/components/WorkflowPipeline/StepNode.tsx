import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { WorkflowStep } from '../../bindings';

export type TaskExecutionStatus = 'waiting' | 'in_progress' | 'completed' | 'failed';

export interface ExecutingTask {
  id: string;
  title: string;
  status: TaskExecutionStatus;
  error?: string;
}

/**
 * Data passed to StepNode
 */
export type StepNodeData = {
  step: WorkflowStep;
  isFirst: boolean;
  isLast: boolean;
  tasks?: ExecutingTask[];
  onPlayClick?: (taskId: string) => void;
  isExecuting?: boolean;
};

export type StepNodeType = Node<StepNodeData, 'stepNode'>;

/**
 * Custom node component for displaying a workflow step in the pipeline.
 * Features neural-pathway-inspired design with glowing connections.
 */
function StepNodeComponent({ data, selected }: NodeProps<StepNodeType>) {
  const { step, isFirst, isLast, tasks = [] } = data;
  const hasSystemPrompt = Boolean(
    step.agent_config.system_prompt || step.agent_config.append_system_prompt
  );
  const toolCount =
    step.agent_config.tools.length + step.agent_config.allowed_tools.length;

  const getTaskStatusColor = (status: TaskExecutionStatus) => {
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

  const getTaskStatusIcon = (status: TaskExecutionStatus) => {
    switch (status) {
      case 'in_progress':
        return '⟳';
      case 'completed':
        return '✓';
      case 'failed':
        return '✕';
      default:
        return '◯';
    }
  };

  return (
    <div
      className={`relative min-w-[200px] rounded-xl border bg-bg-secondary p-4 transition-all duration-200 ${
        selected
          ? 'border-primary shadow-glow'
          : 'border-border hover:border-primary/50 hover:shadow-glow-sm'
      }`}
    >
      {/* Subtle inner glow effect */}
      <div className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-br from-primary/5 to-transparent" />

      {/* Input handle - hidden for first step */}
      {!isFirst && (
        <Handle
          type="target"
          position={Position.Left}
          className="!-left-1 !h-3 !w-3 !rounded-full !border-2 !border-primary !bg-bg-primary !shadow-glow-sm"
        />
      )}

      {/* Step header with order badge */}
      <div className="relative mb-3 flex items-center gap-3">
        <div className="relative">
          <span className={`flex h-7 w-7 items-center justify-center rounded-lg border font-mono text-xs font-bold ${
            isFirst
              ? 'border-accent/30 bg-accent/10 text-accent'
              : 'border-primary/30 bg-primary/10 text-primary'
          }`}>
            {step.order + 1}
          </span>
          {/* Pulse effect for first step */}
          {isFirst && (
            <span className="absolute inset-0 animate-ping rounded-lg border border-accent opacity-20" />
          )}
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-text-primary">{step.name}</h3>
          {step.agent_config.model && (
            <p className="mt-0.5 truncate font-mono text-[10px] text-text-muted">
              {step.agent_config.model}
            </p>
          )}
        </div>
      </div>

      {/* Executing tasks display */}
      {tasks.length > 0 && (
        <div className="relative mb-3 max-h-[120px] space-y-1.5 overflow-y-auto border-t border-b border-border py-2">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`rounded-lg border px-2 py-1.5 transition-all duration-200 ${getTaskStatusColor(
                task.status
              )}`}
            >
              <div className="flex items-start gap-2">
                <span
                  className={`mt-0.5 flex-shrink-0 text-xs font-bold ${
                    task.status === 'in_progress'
                      ? 'animate-spin text-accent'
                      : task.status === 'completed'
                        ? 'text-success'
                        : task.status === 'failed'
                          ? 'text-error'
                          : 'text-text-muted'
                  }`}
                >
                  {getTaskStatusIcon(task.status)}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="truncate text-xs font-medium text-text-primary" title={task.title}>
                    {task.title}
                  </p>
                  <code className="block truncate font-mono text-[10px] text-text-muted">
                    {task.id.slice(0, 8)}
                  </code>
                </div>
              </div>
              {task.error && (
                <p className="mt-1 text-[10px] text-error truncate" title={task.error}>
                  Error: {task.error}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Agent config indicators */}
      <div className="relative flex flex-wrap gap-1.5">
        {hasSystemPrompt && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-info/30 bg-info/10 px-2 py-0.5 text-[10px] font-medium text-info"
            title="Has system prompt configured"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            Prompt
          </span>
        )}
        {toolCount > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success"
            title={`${toolCount} tool(s) configured`}
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {toolCount}
          </span>
        )}
        {step.agent_config.permission_mode && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning"
            title={`Permission mode: ${step.agent_config.permission_mode}`}
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            {step.agent_config.permission_mode}
          </span>
        )}
      </div>

      {/* Step type indicators */}
      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
        {isFirst && (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-accent">
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
            Entry
          </span>
        )}
        {isLast && (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-success">
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
            </svg>
            Exit
          </span>
        )}
        {!isFirst && !isLast && (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
            Process
          </span>
        )}
      </div>

      {/* Output handle - hidden for last step */}
      {!isLast && (
        <Handle
          type="source"
          position={Position.Right}
          className="!-right-1 !h-3 !w-3 !rounded-full !border-2 !border-primary !bg-bg-primary !shadow-glow-sm"
        />
      )}
    </div>
  );
}

/**
 * Memoized StepNode to prevent unnecessary re-renders
 */
export const StepNode = memo(StepNodeComponent);
