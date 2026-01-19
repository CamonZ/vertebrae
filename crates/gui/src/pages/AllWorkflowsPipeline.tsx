import { useState, useEffect, useMemo, useCallback, memo } from "react";
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

import {
  commands,
  type TaskLevel,
  type TaskWithRelations,
  type Step,
} from "../bindings";
import { useWorkflows } from "../hooks/useWorkflows";
import { useWorkflowChangeListener } from "../hooks/useWorkflowChangeListener";
import { useTaskChangeListener } from "../hooks/useTaskChangeListener";
import { useToastStore } from "../stores";
import { StepNode, type StepNodeData } from "../components/WorkflowPipeline";
import {
  WorkflowZoneNode,
  type WorkflowZoneNodeData,
} from "../components/WorkflowPipeline";
import { TaskDetailPanel } from "../components/TaskDetail";
import { StepDetailPanel } from "../components/StepDetail";
import { FilteredTasksPanel } from "../components/FilteredTasks/FilteredTasksPanel";

/**
 * Zone node data type for task containers within workflow zones
 */
type TaskZoneNodeData = {
  label: string;
  tasks: TaskWithRelations[];
  executionState?: Map<
    string,
    { currentStep: string | number; status: string; error?: string }
  >;
  onTaskClick?: (taskId: string) => void;
  selectedTaskId?: string | null;
  onZoneClick?: (step: Step) => void;
  step?: Step;
  isZoneActive?: boolean;
  [key: string]: unknown;
};

/**
 * Custom zone node component - scrollable container for tasks
 */
const TaskZoneNode = memo(function TaskZoneNode({
  data,
}: NodeProps<Node<TaskZoneNodeData>>) {
  const {
    label,
    tasks = [],
    executionState,
    onTaskClick,
    selectedTaskId,
    onZoneClick,
    step,
  } = data;

  // Determine if this zone is active (currently showing filtered tasks panel)
  const isZoneActive = data.isZoneActive ?? false;

  const getStatusColor = (status: string, isSelected: boolean) => {
    if (isSelected) {
      return "border-primary bg-primary/20 ring-1 ring-primary/50";
    }
    switch (status) {
      case "in_progress":
        return "border-accent bg-accent/10";
      case "completed":
      case "done":
        return "border-success/50 bg-success/5";
      case "failed":
        return "border-error bg-error/10";
      default:
        return "border-border bg-bg-tertiary";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "in_progress":
        return "⟳";
      case "completed":
      case "done":
        return "✓";
      case "failed":
        return "✕";
      default:
        return "○";
    }
  };

  const getLevelDotColor = (level: TaskLevel) => {
    switch (level) {
      case "epic":
        return "bg-info";
      case "ticket":
        return "bg-primary";
      case "task":
        return "bg-text-secondary";
      default:
        return "bg-text-muted";
    }
  };

  const handleZoneClick = () => {
    if (step && onZoneClick) {
      onZoneClick(step);
    }
  };

  // Determine title styles based on active state (hover via CSS)
  const getTitleClassName = () => {
    const base =
      "text-xs font-semibold uppercase tracking-wider mb-2 px-1 transition-colors cursor-pointer rounded text-left";
    if (isZoneActive) {
      return `${base} text-primary font-bold`;
    }
    return `${base} text-text-muted hover:text-warning`;
  };

  return (
    <div className="flex flex-col w-[280px] h-[280px] text-left">
      <button
        type="button"
        onClick={handleZoneClick}
        className={getTitleClassName()}
      >
        {label}
      </button>
      <div className="flex-1 overflow-y-auto overflow-x-hidden space-y-1.5 pr-1 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
        {tasks.map((tr) => {
          const execState = executionState?.get(tr.task.id!);
          const status =
            tr.task.status === "done" || tr.task.status === "rejected"
              ? "done"
              : execState?.status || "waiting";
          const isSelected = selectedTaskId === tr.task.id;

          return (
            <button
              key={tr.task.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTaskClick?.(tr.task.id!);
              }}
              className={`w-full text-left rounded-lg border p-2 transition-all duration-200 ${getStatusColor(status, isSelected)} hover:border-primary/50 cursor-pointer`}
            >
              <div className="flex items-start gap-2">
                <span
                  className={`flex-shrink-0 text-xs font-bold ${
                    status === "in_progress"
                      ? "animate-spin text-accent"
                      : status === "done"
                        ? "text-success"
                        : status === "failed"
                          ? "text-error"
                          : "text-text-muted"
                  }`}
                >
                  {getStatusIcon(status)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`flex-shrink-0 w-2 h-2 rounded-full ${getLevelDotColor(tr.task.level)}`}
                      title={tr.task.level}
                    />
                    <p
                      className="truncate text-xs font-medium text-text-primary"
                      title={tr.task.title}
                    >
                      {tr.task.title}
                    </p>
                  </div>
                  <code className="block truncate font-mono text-[10px] text-text-muted">
                    {(tr.task.id ?? "").slice(0, 8)}
                  </code>
                </div>
              </div>
            </button>
          );
        })}
        {tasks.length === 0 && (
          <div className="text-xs text-text-muted italic px-1">No tasks</div>
        )}
      </div>
    </div>
  );
});

/**
 * Node type mapping for React Flow
 */
const nodeTypes: NodeTypes = {
  stepNode: StepNode,
  taskZoneNode: TaskZoneNode,
  workflowZoneNode: WorkflowZoneNode,
};

/**
 * Layout constants
 */
const NODE_SPACING_X = 320; // Horizontal spacing between step nodes
const STEP_Y_OFFSET = 80; // Y offset for step nodes within workflow zone
const TASK_ZONE_Y_OFFSET = 220; // Y offset for task zones within workflow zone
const WORKFLOW_ZONE_PADDING = 40; // Padding around workflow zone content
const WORKFLOW_ZONE_HEADER_HEIGHT = 80; // Height reserved for workflow header
const WORKFLOW_ZONE_GAP = 60; // Vertical gap between workflow zones

/**
 * Calculate the width needed for a workflow zone based on number of steps
 */
function calculateWorkflowZoneWidth(stepCount: number): number {
  if (stepCount === 0) return 400;
  return stepCount * NODE_SPACING_X + WORKFLOW_ZONE_PADDING * 2;
}

/**
 * Calculate the height needed for a workflow zone
 */
function calculateWorkflowZoneHeight(): number {
  return (
    WORKFLOW_ZONE_HEADER_HEIGHT +
    TASK_ZONE_Y_OFFSET +
    280 +
    WORKFLOW_ZONE_PADDING
  );
}

/**
 * Group tasks by their current step for a workflow
 */
function groupTasksByStep(
  tasks: TaskWithRelations[],
  steps: Step[]
): Map<string, TaskWithRelations[]> {
  const sortedSteps = [...steps].sort((a, b) => a.order - b.order);
  const groups = new Map<string, TaskWithRelations[]>();

  // Initialize groups for each step
  sortedSteps.forEach((step) => {
    groups.set(step.name.toLowerCase(), []);
  });

  tasks.forEach((tr) => {
    const taskStatus = tr.task.status?.toLowerCase();

    // Done/rejected tasks go to the last step zone
    if (taskStatus === "done" || taskStatus === "rejected") {
      const lastStep = sortedSteps[sortedSteps.length - 1];
      if (lastStep) {
        groups.get(lastStep.name.toLowerCase())?.push(tr);
      }
      return;
    }

    // Match task status to step name
    if (taskStatus && groups.has(taskStatus)) {
      groups.get(taskStatus)!.push(tr);
      return;
    }

    // Fall back to first step if status doesn't match any step
    const firstStep = sortedSteps[0]?.name?.toLowerCase();
    if (firstStep && groups.has(firstStep)) {
      groups.get(firstStep)!.push(tr);
    }
  });

  return groups;
}

/**
 * AllWorkflowsPipeline displays all workflows in a single React Flow canvas.
 * Each workflow is rendered as a zone with dashed borders containing its pipeline.
 * Features neural-pathway-inspired design with real-time updates.
 */
export function AllWorkflowsPipeline() {
  const { workflows, isLoading, error, refetch } = useWorkflows();
  const addToast = useToastStore((state) => state.addToast);

  // State for fetched task relationships per workflow
  const [workflowTasksMap, setWorkflowTasksMap] = useState<
    Map<string, TaskWithRelations[]>
  >(new Map());

  // State for fetched steps per workflow
  const [workflowStepsMap, setWorkflowStepsMap] = useState<
    Map<string, Step[]>
  >(new Map());

  // State for selected task (for detail panel)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // State for selected step (for step config panel)
  const [selectedStep, setSelectedStep] = useState<Step | null>(null);

  // State for selected zone (workflow ID + step for filtered tasks panel)
  const [selectedZone, setSelectedZone] = useState<{
    workflowId: string;
    step: Step;
  } | null>(null);

  // Task selection handlers
  const handleTaskClick = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    setSelectedStep(null); // Clear step selection when task is selected
  }, []);

  const handleCloseTaskPanel = useCallback(() => {
    setSelectedTaskId(null);
  }, []);

  const handleRelatedTaskSelect = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    setSelectedStep(null);
  }, []);

  // Step selection handlers
  const handleStepClick = useCallback((step: Step) => {
    setSelectedStep(step);
    setSelectedTaskId(null); // Clear task selection when step is selected
  }, []);

  const handleCloseStepPanel = useCallback(() => {
    setSelectedStep(null);
  }, []);

  // Zone selection handlers (for filtered tasks panel)
  const handleZoneClick = useCallback(
    (workflowId: string, step: Step) => {
      setSelectedZone({ workflowId, step });
      setSelectedTaskId(null); // Clear task selection
      setSelectedStep(null); // Clear step config selection
    },
    []
  );

  const handleCloseZonePanel = useCallback(() => {
    setSelectedZone(null);
  }, []);

  // Fetch task details and steps for all workflows
  useEffect(() => {
    const fetchAllWorkflowData = async () => {
      if (workflows.length === 0) {
        setWorkflowTasksMap(new Map());
        setWorkflowStepsMap(new Map());
        return;
      }

      const tasksMap = new Map<string, TaskWithRelations[]>();
      const stepsMap = new Map<string, Step[]>();

      try {
        for (const workflow of workflows) {
          // Skip workflows without an ID
          const workflowId = workflow.id;
          if (!workflowId) continue;

          // Fetch tasks for this workflow
          try {
            const tasksResult = await commands.getWorkflowWithTaskDetails(
              workflowId
            );
            if (tasksResult.status === "ok") {
              tasksMap.set(workflowId, tasksResult.data.tasks);
            } else {
              console.warn(
                `Failed to load tasks for workflow ${workflowId}:`,
                tasksResult.error.message
              );
              tasksMap.set(workflowId, []);
            }
          } catch (err) {
            console.warn(
              `Failed to load tasks for workflow ${workflowId}:`,
              String(err)
            );
            tasksMap.set(workflowId, []);
          }

          // Fetch steps for this workflow
          try {
            const stepsResult = await commands.listStepsForWorkflow(
              workflowId
            );
            if (stepsResult.status === "ok") {
              stepsMap.set(workflowId, stepsResult.data);
            } else {
              console.warn(
                `Failed to load steps for workflow ${workflowId}:`,
                stepsResult.error.message
              );
              stepsMap.set(workflowId, []);
            }
          } catch (err) {
            console.warn(
              `Failed to load steps for workflow ${workflowId}:`,
              String(err)
            );
            stepsMap.set(workflowId, []);
          }
        }
      } catch (err) {
        addToast(`Failed to load workflow data: ${String(err)}`, "error");
      }

      setWorkflowTasksMap(tasksMap);
      setWorkflowStepsMap(stepsMap);
    };

    fetchAllWorkflowData();
  }, [workflows, addToast]);

  // Subscribe to workflow change events for automatic list refresh
  useWorkflowChangeListener({
    onWorkflowListChange: refetch,
  });

  // Subscribe to task change events - reload all workflow tasks when any task changes
  useTaskChangeListener({
    onTaskListChange: () => {
      refetch();
    },
  });

  // Generate all nodes for the unified canvas
  const allNodes = useMemo(() => {
    const nodes: Node[] = [];
    let currentY = 0;

    workflows.forEach((workflow) => {
      // Skip workflows without an ID
      const workflowId = workflow.id;
      if (!workflowId) return;

      const workflowSteps = workflowStepsMap.get(workflowId) || [];
      const sortedSteps = [...workflowSteps].sort((a, b) => a.order - b.order);
      const workflowTasks = workflowTasksMap.get(workflowId) || [];
      const tasksByStep = groupTasksByStep(workflowTasks, workflowSteps);

      const zoneWidth = calculateWorkflowZoneWidth(sortedSteps.length);
      const zoneHeight = calculateWorkflowZoneHeight();

      // Add workflow zone node
      nodes.push({
        id: `workflow-zone-${workflowId}`,
        type: "workflowZoneNode",
        position: { x: 0, y: currentY },
        data: {
          workflow,
          taskCount: workflowTasks.length,
          width: zoneWidth,
          height: zoneHeight,
        } as WorkflowZoneNodeData,
        draggable: false,
        selectable: false,
      });

      // Add step nodes within this workflow zone
      sortedSteps.forEach((step, index) => {
        const isStepSelected =
          selectedStep?.name === step.name &&
          selectedStep?.order === step.order;
        nodes.push({
          id: `step-${workflowId}-${step.order}`,
          type: "stepNode",
          position: {
            x: WORKFLOW_ZONE_PADDING + index * NODE_SPACING_X,
            y: currentY + WORKFLOW_ZONE_HEADER_HEIGHT + STEP_Y_OFFSET,
          },
          data: {
            step,
            isFirst: index === 0,
            isLast: index === sortedSteps.length - 1,
            onStepClick: handleStepClick,
            isSelected: isStepSelected,
          } as StepNodeData,
          draggable: false,
        });

        // Add task zone node below each step
        const stepTasks = tasksByStep.get(step.name.toLowerCase()) || [];
        const isZoneActive =
          selectedZone?.workflowId === workflowId &&
          selectedZone?.step.order === step.order;
        nodes.push({
          id: `task-zone-${workflowId}-${step.order}`,
          type: "taskZoneNode",
          position: {
            x: WORKFLOW_ZONE_PADDING + index * NODE_SPACING_X - 9, // Center offset
            y: currentY + WORKFLOW_ZONE_HEADER_HEIGHT + TASK_ZONE_Y_OFFSET,
          },
          data: {
            label: `${step.name} (${stepTasks.length})`,
            tasks: stepTasks,
            onTaskClick: handleTaskClick,
            selectedTaskId,
            step,
            onZoneClick: () => handleZoneClick(workflowId, step),
            isZoneActive,
          } as TaskZoneNodeData,
          style: {
            background: "rgba(15, 15, 18, 0.8)",
            border: "1px solid rgba(100, 116, 139, 0.3)",
            borderRadius: "8px",
            padding: "8px",
          },
          draggable: false,
          selectable: true,
        });
      });

      // Move to next workflow zone position
      currentY += zoneHeight + WORKFLOW_ZONE_GAP;
    });

    return nodes;
  }, [
    workflows,
    workflowTasksMap,
    workflowStepsMap,
    handleTaskClick,
    selectedTaskId,
    handleStepClick,
    selectedStep,
    handleZoneClick,
    selectedZone,
  ]);

  const [nodes, setNodes, onNodesChange] = useNodesState(allNodes);
  const [edges, , onEdgesChange] = useEdgesState([]);

  // Update nodes when allNodes changes
  useEffect(() => {
    setNodes(allNodes);
  }, [allNodes, setNodes]);

  // Handle loading state
  if (isLoading && workflows.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
            <div className="absolute inset-0 animate-pulse rounded-full bg-primary/10" />
          </div>
          <p className="text-sm text-text-muted">Loading workflows...</p>
        </div>
      </div>
    );
  }

  // Handle error state
  if (error && workflows.length === 0) {
    return (
      <div className="m-6 rounded-xl border border-error/30 bg-error/5 p-6">
        <h2 className="mb-2 text-lg font-semibold text-text-primary">
          Error Loading Workflows
        </h2>
        <p className="mb-4 font-mono text-sm text-error">{error}</p>
        <button
          onClick={refetch}
          className="rounded-lg bg-error px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-error/90"
        >
          Try Again
        </button>
      </div>
    );
  }

  // Handle empty state
  if (workflows.length === 0) {
    return (
      <div className="relative flex-1 overflow-auto p-6">
        <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

        <div className="relative">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-text-primary">
              Workflow Pipelines
            </h1>
            <p className="mt-2 text-sm text-text-muted">
              All workflows visualized as connected pipelines
            </p>
          </div>

          <div className="flex h-96 items-center justify-center rounded-xl border border-border bg-bg-secondary">
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
                No workflows yet
              </p>
              <p className="mt-1 text-xs text-text-muted">
                Create a workflow to get started
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* Main content area */}
      <div className="relative flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="relative border-b border-border bg-bg-primary px-6 py-4">
          <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />
          <div className="relative">
            <h1 className="text-lg font-semibold text-text-primary">
              Workflow Pipelines
            </h1>
            <p className="mt-1 text-sm text-text-muted">
              {workflows.length} workflow{workflows.length !== 1 ? "s" : ""}{" "}
              visualized
            </p>
          </div>
        </div>

        {/* React Flow Canvas */}
        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.1, minZoom: 0.3, maxZoom: 1.5 }}
            minZoom={0.1}
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
      </div>

      {/* Task Detail Panel */}
      {selectedTaskId && (
        <TaskDetailPanel
          taskId={selectedTaskId}
          onClose={handleCloseTaskPanel}
          onTaskSelect={handleRelatedTaskSelect}
        />
      )}

      {/* Step Detail Panel */}
      {selectedStep && (
        <StepDetailPanel step={selectedStep} onClose={handleCloseStepPanel} />
      )}

      {/* Filtered Tasks Panel */}
      {selectedZone &&
        (() => {
          const allWorkflowTasks =
            workflowTasksMap.get(selectedZone.workflowId) || [];
          // Get steps for this workflow
          const workflowSteps =
            workflowStepsMap.get(selectedZone.workflowId) || [];
          if (workflowSteps.length === 0) return null;

          // Group tasks by step
          const tasksByStep = groupTasksByStep(
            allWorkflowTasks,
            workflowSteps
          );
          // Get tasks for selected step
          const stepTasks =
            tasksByStep.get(selectedZone.step.name.toLowerCase()) || [];
          // Convert TaskWithRelations to TaskSummary for the panel
          // Filter out any tasks without IDs and map to TaskSummary format
          const taskSummaries = stepTasks
            .filter((tr) => tr.task.id !== null)
            .map((tr) => ({
              id: tr.task.id as string,
              title: tr.task.title,
              level: tr.task.level,
              status: tr.task.status,
              priority: tr.task.priority,
              tags: tr.task.tags,
              needs_human_review: tr.task.needs_human_review,
              created_at: tr.task.created_at ?? new Date().toISOString(),
            }));

          return (
            <FilteredTasksPanel
              step={selectedZone.step}
              tasks={taskSummaries}
              workflowId={selectedZone.workflowId}
              onClose={handleCloseZonePanel}
              onTaskSelect={handleRelatedTaskSelect}
              selectedTaskId={selectedTaskId}
            />
          );
        })()}
    </div>
  );
}
