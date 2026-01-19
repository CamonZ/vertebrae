import { useMemo, useEffect } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Node,
  type NodeTypes,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { StepNode, type StepNodeData } from "./StepNode";
import type { Workflow, TaskWithRelations, Step } from "../../bindings";

/**
 * Zone node data type
 */
type ZoneNodeData = {
  label: string;
  tasks: TaskWithRelations[];
  executionState?: Map<string, { currentStep: string | number; status: string; error?: string }>;
  [key: string]: unknown;
};

/**
 * Get border/background color based on task status.
 * Status is a macro concept - it shows the overall state of the task.
 */
function getTaskStatusColor(status: string) {
  switch (status) {
    case "in_progress":
      return "border-accent bg-accent/10";
    case "pending_review":
      return "border-warning bg-warning/10";
    case "done":
      return "border-success/50 bg-success/5";
    case "rejected":
      return "border-error bg-error/10";
    case "todo":
      return "border-info/50 bg-info/5";
    case "backlog":
    default:
      return "border-border bg-bg-tertiary";
  }
}

/**
 * Get icon based on task status.
 */
function getTaskStatusIcon(status: string) {
  switch (status) {
    case "in_progress":
      return "⟳";
    case "pending_review":
      return "◈";
    case "done":
      return "✓";
    case "rejected":
      return "✕";
    case "todo":
      return "◉";
    case "backlog":
    default:
      return "○";
  }
}

/**
 * Get icon color based on task status.
 */
function getTaskStatusIconColor(status: string) {
  switch (status) {
    case "in_progress":
      return "animate-spin text-accent";
    case "pending_review":
      return "text-warning";
    case "done":
      return "text-success";
    case "rejected":
      return "text-error";
    case "todo":
      return "text-info";
    case "backlog":
    default:
      return "text-text-muted";
  }
}

/**
 * Custom zone node component - scrollable container for tasks.
 * Tasks are positioned here based on current_step_id (micro concept).
 * Task status is shown via border colors and icons (macro concept).
 */
function ZoneNode({ data }: NodeProps<Node<ZoneNodeData>>) {
  const { label, tasks = [] } = data;

  return (
    <div className="flex flex-col w-[280px] h-[280px]">
      <div className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2 px-1">
        {label}
      </div>
      <div className="flex-1 overflow-y-auto overflow-x-hidden space-y-1.5 pr-1 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
        {tasks.map((tr) => {
          // Use task status for visual styling (border color indicates macro state)
          // Position is determined by current_step_id in the parent component
          const taskStatus = tr.task.status;

          return (
            <div
              key={tr.task.id}
              className={`rounded-lg border p-2 transition-all duration-200 ${getTaskStatusColor(taskStatus)} hover:border-primary/50`}
            >
              <div className="flex items-start gap-2">
                <span
                  className={`flex-shrink-0 text-xs font-bold ${getTaskStatusIconColor(taskStatus)}`}
                >
                  {getTaskStatusIcon(taskStatus)}
                </span>
                <div className="flex-1 min-w-0">
                  <p
                    className="truncate text-xs font-medium text-text-primary"
                    title={tr.task.title}
                  >
                    {tr.task.title}
                  </p>
                  <code className="block truncate font-mono text-[10px] text-text-muted">
                    {(tr.task.id ?? "").slice(0, 8)}
                  </code>
                </div>
              </div>
            </div>
          );
        })}
        {tasks.length === 0 && (
          <div className="text-xs text-text-muted italic px-1">No tasks</div>
        )}
      </div>
    </div>
  );
}

/**
 * Props for WorkflowPipeline component
 */
interface WorkflowPipelineProps {
  workflow: Workflow;
  /** First-class Step entities for this workflow */
  steps: Step[];
  executionState?: Map<
    string,
    { currentStep: string | number; status: string; error?: string }
  >;
  tasksWithRelations?: TaskWithRelations[];
  /** Map from step ID to step name for resolving current_step_id */
  stepIdToName?: Map<string, string>;
  onPlayClick?: (taskId: string) => void;
  isExecuting?: boolean;
}

/**
 * Node type mapping for React Flow
 */
const nodeTypes: NodeTypes = {
  stepNode: StepNode,
  zoneNode: ZoneNode,
};

/**
 * Horizontal spacing between step nodes
 */
const NODE_SPACING_X = 320;

/**
 * Vertical position for step nodes (single row layout)
 */
const NODE_Y_POSITION = 80;

/**
 * WorkflowPipeline displays workflow steps and tasks as a connected React Flow diagram.
 * Tasks are positioned on the left showing dependencies.
 * Steps are positioned on the right showing workflow progression.
 * Executing tasks animate between their current step position.
 */
export function WorkflowPipeline({
  workflow: _workflow,
  steps,
  executionState,
  tasksWithRelations = [],
  stepIdToName,
  onPlayClick,
  isExecuting,
}: WorkflowPipelineProps) {
  // Sort steps by order to ensure correct layout
  const sortedSteps = useMemo(
    () => [...steps].sort((a, b) => a.order - b.order),
    [steps]
  );

  // Zone positioning constants
  const STEP_ZONE_Y = 220; // Below step nodes (80 + 130 + 10 padding)

  // Group tasks by their current step
  // Priority: current_step_id > executionState > first step (for active tasks)
  // Done/rejected tasks always go to the "done" zone
  const tasksByStep = useMemo(() => {
    const groups: Map<string, TaskWithRelations[]> = new Map();

    // Initialize groups for each step
    sortedSteps.forEach((step) => {
      groups.set(step.name.toLowerCase(), []);
    });

    tasksWithRelations.forEach((tr) => {
      // Done/rejected tasks go to the "done" step zone (visual indicator)
      // Note: The status border will still show the task as done/rejected
      if (tr.task.status === "done" || tr.task.status === "rejected") {
        if (groups.has("done")) {
          groups.get("done")!.push(tr);
          return;
        }
      }

      // 1. Use current_step_id if available (primary positioning source)
      if (tr.task.current_step_id && stepIdToName) {
        const stepName = stepIdToName.get(tr.task.current_step_id);
        if (stepName && groups.has(stepName.toLowerCase())) {
          groups.get(stepName.toLowerCase())!.push(tr);
          return;
        }
      }

      // 2. Use execution state for real-time animation during workflow execution
      const execState = executionState?.get(tr.task.id!);
      if (execState) {
        let stepName: string | undefined;
        if (typeof execState.currentStep === "number") {
          stepName = sortedSteps[execState.currentStep]?.name?.toLowerCase();
        } else if (typeof execState.currentStep === "string") {
          stepName = execState.currentStep.toLowerCase();
        }

        if (stepName && groups.has(stepName)) {
          groups.get(stepName)!.push(tr);
          return;
        }
      }

      // 3. Default to first step if no position info available
      const firstStep = sortedSteps[0]?.name?.toLowerCase();
      if (firstStep && groups.has(firstStep)) {
        groups.get(firstStep)!.push(tr);
      }
    });

    return groups;
  }, [tasksWithRelations, executionState, sortedSteps, stepIdToName]);

  // Convert workflow steps to React Flow nodes (positioned horizontally)
  const stepNodes: Node<StepNodeData>[] = useMemo(
    () =>
      sortedSteps.map((step, index) => ({
        id: `step-${step.order}`,
        type: "stepNode",
        position: { x: index * NODE_SPACING_X, y: NODE_Y_POSITION },
        data: {
          step,
          isFirst: index === 0,
          isLast: index === sortedSteps.length - 1,
          onPlayClick,
          isExecuting,
        },
      })),
    [sortedSteps, onPlayClick, isExecuting]
  );

  // Create zone nodes with tasks inside (scrollable containers)
  // Zone has 8px padding + 1px border on each side = 18px extra width
  // Offset by half to center under step node
  const ZONE_CENTER_OFFSET = 9;
  const zoneNodes = useMemo(() => {
    return sortedSteps.map((step, index) => {
      const stepTasks = tasksByStep.get(step.name.toLowerCase()) || [];
      return {
        id: `zone-step-${step.order}`,
        type: "zoneNode",
        position: {
          x: index * NODE_SPACING_X - ZONE_CENTER_OFFSET, // Center under step node
          y: STEP_ZONE_Y,
        },
        data: {
          label: `${step.name} (${stepTasks.length})`,
          tasks: stepTasks,
          executionState,
        },
        style: {
          background: "rgba(15, 15, 18, 0.8)",
          border: "1px solid rgba(100, 116, 139, 0.3)",
          borderRadius: "8px",
          padding: "8px",
        },
        draggable: false,
      };
    });
  }, [tasksByStep, sortedSteps, executionState]);

  // Combine all nodes (zones and steps)
  const allNodes = useMemo(
    () => [...zoneNodes, ...stepNodes],
    [zoneNodes, stepNodes]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(allNodes);
  const [edges, , onEdgesChange] = useEdgesState([]);

  // Update nodes when allNodes changes
  useEffect(() => {
    setNodes(allNodes);
  }, [allNodes, setNodes]);

  if (sortedSteps.length === 0) {
    return (
      <div className="relative flex h-[400px] items-center justify-center rounded-xl border border-border bg-bg-secondary">
        {/* Neural grid background */}
        <div className="neural-grid pointer-events-none absolute inset-0 rounded-xl opacity-30" />

        <div className="relative text-center">
          <svg
            className="mx-auto h-12 w-12 text-text-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          <p className="mt-3 text-sm font-medium text-text-primary">
            No steps defined
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Add steps to this workflow to create a pipeline
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-[600px] overflow-hidden rounded-xl border border-border bg-bg-secondary">
      {/* Subtle gradient overlay */}
      <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-b from-transparent via-transparent to-bg-secondary/50" />

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, minZoom: 0.5, maxZoom: 1.5 }}
        minZoom={0.25}
        maxZoom={2}
        colorMode="dark"
        attributionPosition="bottom-left"
        proOptions={{ hideAttribution: true }}
        style={{ backgroundColor: "#0c0c0e" }}
      >
        <Controls
          showInteractive={false}
          className="!rounded-lg !border-border !bg-bg-elevated !shadow-lg"
        />
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#57534e"
          bgColor="#0c0c0e"
        />
      </ReactFlow>
    </div>
  );
}
