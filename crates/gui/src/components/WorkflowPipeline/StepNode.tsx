import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { Step } from "../../bindings";
import { formatAgentModelLabel } from "../../utils/agentConfigLabel";
import { NODE_SIZING, NODE_SHADOW_STYLE, HANDLE_SIZING } from "./nodeConstants";
import { stepTypeStyle } from "./stepTypeStyling";

/**
 * Data passed to StepNode
 */
export type StepNodeData = {
  step: Step;
  isFirst: boolean;
  isLast: boolean;
  onPlayClick?: (taskId: string) => void;
  isExecuting?: boolean;
  onStepClick?: (step: Step) => void;
  isSelected?: boolean;
  taskCounts?: { epic: number; ticket: number; task: number };
  executionCounts?: { active: number; completed: number; failed: number };
  isFlashing?: boolean;
};

export type StepNodeType = Node<StepNodeData, "stepNode">;

/**
 * Custom node component for displaying a workflow step in the pipeline.
 * Features neural-pathway-inspired design with glowing connections.
 */
function StepNodeComponent({ data, selected }: NodeProps<StepNodeType>) {
  const {
    step,
    isFirst,
    isLast,
    onStepClick,
    isSelected,
    taskCounts,
    executionCounts,
    isFlashing,
  } = data;

  const handleClick = () => {
    onStepClick?.(step);
  };
  const agentConfig = step.agent_config;
  const hasSystemPrompt = Boolean(
    agentConfig?.system_prompt || agentConfig?.append_system_prompt
  );
  const toolCount =
    (agentConfig?.tools ?? []).length +
    (agentConfig?.allowed_tools ?? []).length;

  // Use isSelected from data prop if available, otherwise fall back to ReactFlow's selected
  const isNodeSelected = isSelected ?? selected;
  const typeStyle = stepTypeStyle(step.step_type);
  const isExecuting = data.isExecuting;

  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid={`step-node-${step.name}`}
      data-step-kind={typeStyle.kind}
      className={`group relative ${NODE_SIZING.widthClass} ${NODE_SIZING.stepHeightClass} rounded-md border bg-bg-2 ${NODE_SIZING.paddingClass} ${NODE_SIZING.overflowClass} flex flex-col transition-all duration-200 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent text-left ${
        isFlashing ? "animate-flash-border" : ""
      } ${
        isNodeSelected
          ? "border-accent/50 bg-accent/10 shadow-glow-sm"
          : "border-border/90 hover:border-border hover:bg-bg-hover"
      }`}
      style={{
        boxShadow: isExecuting
          ? `0 0 0 1px color-mix(in oklch, var(${typeStyle.barVar}) 55%, transparent), ${NODE_SHADOW_STYLE.boxShadow}`
          : NODE_SHADOW_STYLE.boxShadow,
      }}
    >
      {/* Top step-type accent bar */}
      <span
        aria-hidden
        data-testid="step-type-bar"
        className={`pointer-events-none absolute left-0 right-0 top-0 h-1 ${
          isExecuting ? "animate-status-pulse" : ""
        }`}
        style={{ backgroundColor: `var(${typeStyle.barVar})` }}
      />

      {/* Subtle inner glow effect */}
      <div
        className={`pointer-events-none absolute inset-0 ${NODE_SIZING.borderRadiusClass} from-accent/5 to-transparent`}
      />

      <Handle
        type="target"
        position={Position.Left}
        isConnectable={!isFirst}
        className={`!-left-1.5 ${HANDLE_SIZING.heightClass} ${HANDLE_SIZING.widthClass} ${HANDLE_SIZING.roundedClass} ${HANDLE_SIZING.borderClass} !border-accent ${HANDLE_SIZING.bgClass} !shadow-glow-sm ${isFirst ? "!opacity-0" : ""}`}
      />

      {/* Step header with order badge */}
      <div className="relative mb-3 flex items-center gap-3">
        <div className="relative">
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-md border font-mono text-xs font-bold ${
              isFirst
                ? "border-accent/30 bg-accent/10 text-accent"
                : "border-accent/30 bg-accent/10 text-accent"
            }`}
          >
            {(step.order ?? 0) + 1}
          </span>
          {/* Pulse effect for first step */}
          {isFirst && (
            <span className="absolute inset-0 animate-ping rounded-lg border border-accent opacity-20" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3
              className="text-sm font-semibold text-fg truncate"
              title={step.goal || step.name}
            >
              {step.name}
            </h3>
            {step.is_final && (
              <span className="inline-flex flex-shrink-0 items-center rounded-full bg-warn/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-warn">
                Final
              </span>
            )}
            <span
              data-testid="step-type-icon"
              title={typeStyle.label}
              aria-label={typeStyle.label}
              className="ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border border-border bg-bg px-1 font-mono text-[10px] uppercase"
              style={{ color: `var(${typeStyle.fgVar})` }}
            >
              {typeStyle.hearthKind}
            </span>
          </div>
          {step.goal && (
            <div className="w-2/3">
              <p
                className="mt-0.5 truncate text-2xs text-fg-soft"
                title={step.goal}
              >
                {step.goal}
              </p>
            </div>
          )}
          {!step.goal && agentConfig?.model && (
            <p className="mt-0.5 truncate font-mono text-2xs text-fg-mute">
              {formatAgentModelLabel(agentConfig)}
            </p>
          )}
        </div>
      </div>

      {/* Agent config indicators */}
      <div className="relative flex flex-wrap gap-1.5">
        {hasSystemPrompt && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-info/30 bg-info/10 px-2 py-0.5 text-2xs font-medium text-info"
            title="Has system prompt configured"
          >
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
              />
            </svg>
            Prompt
          </span>
        )}
        {toolCount > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-ok/30 bg-ok/10 px-2 py-0.5 text-2xs font-medium text-ok"
            title={`${toolCount} tool(s) configured`}
          >
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            {toolCount}
          </span>
        )}
        {agentConfig?.permission_mode && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-2xs font-medium text-warn"
            title={`Permission mode: ${agentConfig.permission_mode}`}
          >
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
            {agentConfig.permission_mode}
          </span>
        )}
      </div>

      {/* Step type indicators */}
      <div className="mt-auto flex items-center gap-2 border-t border-border pt-3">
        {isFirst && (
          <span className="inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-wider text-accent">
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
              />
            </svg>
            Entry
          </span>
        )}
        {isLast && (
          <span className="inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-wider text-ok">
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M5 13l4 4L19 7"
              />
            </svg>
            Exit
          </span>
        )}
        {!isFirst && !isLast && (
          <span className="inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-wider text-fg-mute">
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M13 7l5 5m0 0l-5 5m5-5H6"
              />
            </svg>
            Process
          </span>
        )}

        {taskCounts &&
          (taskCounts.epic > 0 ||
            taskCounts.ticket > 0 ||
            taskCounts.task > 0) && (
            <div className="ml-auto flex items-center gap-2">
              {taskCounts.epic > 0 && (
                <span
                  className="flex items-center gap-1 text-2xs text-fg-mute"
                  title={`${taskCounts.epic} epic(s)`}
                >
                  <span className="w-2 h-2 rounded-full bg-info" />
                  {taskCounts.epic}
                </span>
              )}
              {taskCounts.ticket > 0 && (
                <span
                  className="flex items-center gap-1 text-2xs text-fg-mute"
                  title={`${taskCounts.ticket} ticket(s)`}
                >
                  <span className="w-2 h-2 rounded-full bg-accent" />
                  {taskCounts.ticket}
                </span>
              )}
              {taskCounts.task > 0 && (
                <span
                  className="flex items-center gap-1 text-2xs text-fg-mute"
                  title={`${taskCounts.task} task(s)`}
                >
                  <span className="w-2 h-2 rounded-full bg-fg-soft" />
                  {taskCounts.task}
                </span>
              )}
            </div>
          )}
      </div>

      {/* Execution activity bar */}
      {executionCounts &&
        (executionCounts.active > 0 ||
          executionCounts.completed > 0 ||
          executionCounts.failed > 0) && (
          <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
            <span className="font-mono text-2xs uppercase tracking-wider text-fg-mute">
              Run
            </span>
            <div className="flex items-center gap-1.5 ml-auto">
              {executionCounts.active > 0 && (
                <span
                  className="flex items-center gap-1 text-2xs text-ok"
                  title={`${executionCounts.active} active`}
                >
                  <span className="w-2 h-2 rounded-full bg-ok" />
                  {executionCounts.active}
                </span>
              )}
              {executionCounts.completed > 0 && (
                <span
                  className="flex items-center gap-1 text-2xs text-ok"
                  title={`${executionCounts.completed} completed`}
                >
                  <span className="w-2 h-2 rounded-full bg-ok" />
                  {executionCounts.completed}
                </span>
              )}
              {executionCounts.failed > 0 && (
                <span
                  className="flex items-center gap-1 text-2xs text-err"
                  title={`${executionCounts.failed} failed`}
                >
                  <span className="w-2 h-2 rounded-full bg-err" />
                  {executionCounts.failed}
                </span>
              )}
            </div>
          </div>
        )}

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={!isLast}
        className={`!-right-1.5 ${HANDLE_SIZING.heightClass} ${HANDLE_SIZING.widthClass} ${HANDLE_SIZING.roundedClass} ${HANDLE_SIZING.borderClass} !border-accent ${HANDLE_SIZING.bgClass} !shadow-glow-sm ${isLast ? "!opacity-0" : ""}`}
      />
    </button>
  );
}

/**
 * Memoized StepNode to prevent unnecessary re-renders
 */
export const StepNode = memo(StepNodeComponent);
