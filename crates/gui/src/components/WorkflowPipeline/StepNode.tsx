import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { WorkflowStep } from '../../bindings';

/**
 * Data passed to StepNode
 */
export type StepNodeData = {
  step: WorkflowStep;
  isFirst: boolean;
  isLast: boolean;
};

export type StepNodeType = Node<StepNodeData, 'stepNode'>;

/**
 * Custom node component for displaying a workflow step in the pipeline.
 * Shows the step name, order, and agent configuration status.
 */
function StepNodeComponent({ data }: NodeProps<StepNodeType>) {
  const { step, isFirst, isLast } = data;
  const hasModel = Boolean(step.agent_config.model);
  const hasSystemPrompt = Boolean(
    step.agent_config.system_prompt || step.agent_config.append_system_prompt
  );
  const toolCount =
    step.agent_config.tools.length + step.agent_config.allowed_tools.length;

  return (
    <div className="min-w-[180px] rounded-lg border border-border bg-bg-primary p-4 shadow-md transition-shadow hover:shadow-lg">
      {/* Input handle - hidden for first step */}
      {!isFirst && (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-3 !w-3 !border-2 !border-primary !bg-bg-primary"
        />
      )}

      {/* Step header with order badge */}
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
          {step.order + 1}
        </span>
        <h3 className="font-semibold text-text-primary">{step.name}</h3>
      </div>

      {/* Agent config indicators */}
      <div className="flex flex-wrap gap-1.5">
        {hasModel && (
          <span
            className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900 dark:text-blue-200"
            title={`Model: ${step.agent_config.model}`}
          >
            Model
          </span>
        )}
        {hasSystemPrompt && (
          <span
            className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900 dark:text-purple-200"
            title="Has system prompt configured"
          >
            Prompt
          </span>
        )}
        {toolCount > 0 && (
          <span
            className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-200"
            title={`${toolCount} tool(s) configured`}
          >
            {toolCount} Tool{toolCount !== 1 ? 's' : ''}
          </span>
        )}
        {step.agent_config.permission_mode && (
          <span
            className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200"
            title={`Permission mode: ${step.agent_config.permission_mode}`}
          >
            {step.agent_config.permission_mode}
          </span>
        )}
      </div>

      {/* Output handle - hidden for last step */}
      {!isLast && (
        <Handle
          type="source"
          position={Position.Right}
          className="!h-3 !w-3 !border-2 !border-primary !bg-bg-primary"
        />
      )}
    </div>
  );
}

/**
 * Memoized StepNode to prevent unnecessary re-renders
 */
export const StepNode = memo(StepNodeComponent);
