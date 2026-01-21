import { useState, useEffect, useMemo, useCallback } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  commands,
  type TaskWithRelations,
  type Step,
  type Workflow,
  type WorkflowTransition,
} from "../bindings";
import { useWorkflows } from "../hooks/useWorkflows";
import { useWorkflowChangeListener } from "../hooks/useWorkflowChangeListener";
import { useTaskChangeListener } from "../hooks/useTaskChangeListener";
import { useElkLayout, type LayoutNode, type LayoutEdge } from "../hooks";
import { useToastStore } from "../stores";
import { groupTasksByStep } from "../utils";
import {
  StepNode,
  type StepNodeData,
  WorkflowZoneNode,
  type WorkflowZoneNodeData,
  TaskZoneNode,
  type TaskZoneNodeData,
  ElkRoutedEdge,
  type ElkRoutedEdgeData,
  LAYOUT_CONSTANTS,
  calculateWorkflowZoneWidth,
  calculateWorkflowZoneHeight,
  COLLAPSED_WORKFLOW_WIDTH,
  COLLAPSED_WORKFLOW_HEIGHT,
} from "../components/WorkflowPipeline";
import { TaskDetailPanel } from "../components/TaskDetail";
import { StepDetailPanel } from "../components/StepDetail";
import { WorkflowDetailPanel } from "../components/WorkflowDetail";
import { FilteredTasksPanel } from "../components/FilteredTasks/FilteredTasksPanel";

/**
 * Node type mapping for React Flow
 */
const nodeTypes: NodeTypes = {
  stepNode: StepNode,
  taskZoneNode: TaskZoneNode,
  workflowZoneNode: WorkflowZoneNode,
};

/**
 * Edge type mapping for React Flow
 */
const edgeTypes: EdgeTypes = {
  elkRouted: ElkRoutedEdge,
};

/**
 * AllWorkflowsPipeline displays all workflows in a single React Flow canvas.
 * Each workflow is rendered as a zone with dashed borders containing its pipeline.
 * Features neural-pathway-inspired design with real-time updates.
 * Press 'c' to toggle collapsed/expanded view.
 */
function AllWorkflowsPipelineInner() {
  const { workflows, isLoading, error, refetch } = useWorkflows();
  const addToast = useToastStore((state) => state.addToast);

  // State for fetched task relationships per workflow
  const [workflowTasksMap, setWorkflowTasksMap] = useState<
    Map<string, TaskWithRelations[]>
  >(new Map());

  // State for fetched steps per workflow
  const [workflowStepsMap, setWorkflowStepsMap] = useState<Map<string, Step[]>>(
    new Map()
  );

  // State for selected task (for detail panel)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // State for selected step (for step config panel)
  const [selectedStep, setSelectedStep] = useState<Step | null>(null);

  // State for selected workflow (for workflow detail panel)
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(
    null
  );

  // State for selected zone (workflow ID + step for filtered tasks panel)
  const [selectedZone, setSelectedZone] = useState<{
    workflowId: string;
    step: Step;
  } | null>(null);

  // State for workflow transitions (edges between workflows)
  const [workflowTransitions, setWorkflowTransitions] = useState<
    WorkflowTransition[]
  >([]);

  // State for collapsed view toggle (press 'c' to toggle)
  const [isCollapsed, setIsCollapsed] = useState(false);

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
    setSelectedWorkflow(null); // Clear workflow selection
  }, []);

  // Workflow selection handlers
  const handleWorkflowClick = useCallback((workflow: Workflow) => {
    setSelectedWorkflow(workflow);
    setSelectedTaskId(null); // Clear task selection
    setSelectedStep(null); // Clear step selection
    setSelectedZone(null); // Clear zone selection
  }, []);

  const handleCloseWorkflowPanel = useCallback(() => {
    setSelectedWorkflow(null);
  }, []);

  const handleCloseStepPanel = useCallback(() => {
    setSelectedStep(null);
  }, []);

  // Zone selection handlers (for filtered tasks panel)
  const handleZoneClick = useCallback((workflowId: string, step: Step) => {
    setSelectedZone({ workflowId, step });
    setSelectedTaskId(null); // Clear task selection
    setSelectedStep(null); // Clear step config selection
  }, []);

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
            const tasksResult =
              await commands.getWorkflowWithTaskDetails(workflowId);
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
            const stepsResult = await commands.listStepsForWorkflow(workflowId);
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

      // Fetch workflow transitions (edges between workflows)
      try {
        const transitionsResult = await commands.listWorkflowTransitions();
        if (transitionsResult.status === "ok") {
          setWorkflowTransitions(transitionsResult.data);
        } else {
          console.warn(
            "Failed to load workflow transitions:",
            transitionsResult.error.message
          );
          setWorkflowTransitions([]);
        }
      } catch (err) {
        console.warn("Failed to load workflow transitions:", String(err));
        setWorkflowTransitions([]);
      }
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

  // Calculate workflow zone dimensions for ELK layout
  // Always use expanded dimensions for consistent positioning
  const workflowDimensions = useMemo(() => {
    const dimensions = new Map<string, { width: number; height: number }>();
    workflows.forEach((workflow) => {
      if (!workflow.id) return;
      // Always use full zone dimensions for ELK layout positioning
      const workflowSteps = workflowStepsMap.get(workflow.id) || [];
      const width = calculateWorkflowZoneWidth(workflowSteps.length);
      const height = calculateWorkflowZoneHeight();
      dimensions.set(workflow.id, { width, height });
    });
    return dimensions;
  }, [workflows, workflowStepsMap]);

  // Build ELK layout nodes from workflows
  const elkLayoutNodes = useMemo((): LayoutNode[] => {
    return workflows
      .filter((w) => w.id)
      .map((workflow) => {
        const dims = workflowDimensions.get(workflow.id!) || { 
          width: 800, 
          height: 400 
        };
        return {
          id: workflow.id!,
          width: dims.width,
          height: dims.height,
        };
      });
  }, [workflows, workflowDimensions]);

  // Build ELK layout edges from workflow transitions
  const elkLayoutEdges = useMemo((): LayoutEdge[] => {
    return workflowTransitions
      .filter((t) => t.from_workflow_id !== t.to_workflow_id) // Skip self-loops for layout
      .map((t, index) => ({
        id: `elk-edge-${index}`,
        source: t.from_workflow_id,
        target: t.to_workflow_id,
      }));
  }, [workflowTransitions]);

  // Calculate ELK layout positions for workflow zones
  const {
    nodes: elkPositions,
    edges: elkEdgePaths,
    isLayouting: _isLayouting,
  } = useElkLayout(elkLayoutNodes, elkLayoutEdges, {
    direction: "DOWN",
    nodeSpacing: 60,
    layerSpacing: 120,
  });

  // Keyboard shortcut to toggle collapsed view
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only toggle if not typing in an input/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === 'c' || e.key === 'C') {
        setIsCollapsed(prev => !prev);
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Generate all nodes for the unified canvas
  const allNodes = useMemo(() => {
    const nodes: Node[] = [];
    let fallbackY = 0; // Fallback for when ELK hasn't calculated positions yet

    workflows.forEach((workflow) => {
      // Skip workflows without an ID
      const workflowId = workflow.id;
      if (!workflowId) return;

      const workflowSteps = workflowStepsMap.get(workflowId) || [];
      const sortedSteps = [...workflowSteps].sort((a, b) => a.order - b.order);
      const workflowTasks = workflowTasksMap.get(workflowId) || [];
      const tasksByStep = groupTasksByStep(workflowTasks, workflowSteps);

      // Use collapsed or expanded dimensions based on toggle
      const zoneWidth = isCollapsed
        ? COLLAPSED_WORKFLOW_WIDTH
        : calculateWorkflowZoneWidth(sortedSteps.length);
      const zoneHeight = isCollapsed
        ? COLLAPSED_WORKFLOW_HEIGHT
        : calculateWorkflowZoneHeight();

      // Use ELK-calculated position or fallback to vertical stacking
      const elkPosition = elkPositions.get(workflowId);
      const zoneX = elkPosition?.x ?? 0;
      const zoneY = elkPosition?.y ?? fallbackY;

      // Add workflow zone node
      nodes.push({
        id: `workflow-zone-${workflowId}`,
        type: "workflowZoneNode",
        position: { x: zoneX, y: zoneY },
        data: {
          workflow,
          taskCount: workflowTasks.length,
          stepCount: sortedSteps.length,
          width: zoneWidth,
          height: zoneHeight,
          onWorkflowClick: handleWorkflowClick,
          isWorkflowSelected: selectedWorkflow?.id === workflowId,
          isCollapsed,
        } as WorkflowZoneNodeData,
        draggable: false,
        selectable: false,
      });

      // Only add step and task nodes when expanded (not collapsed)
      if (!isCollapsed) {
        // Add step nodes within this workflow zone
        sortedSteps.forEach((step, index) => {
          const isStepSelected =
            selectedStep?.name === step.name &&
            selectedStep?.order === step.order;
          nodes.push({
            id: `step-${workflowId}-${step.order}`,
            type: "stepNode",
            position: {
              x:
                zoneX +
                LAYOUT_CONSTANTS.WORKFLOW_ZONE_PADDING +
                index * LAYOUT_CONSTANTS.NODE_SPACING_X,
              y:
                zoneY +
                LAYOUT_CONSTANTS.WORKFLOW_ZONE_HEADER_HEIGHT +
                LAYOUT_CONSTANTS.STEP_Y_OFFSET,
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
              x:
                zoneX +
                LAYOUT_CONSTANTS.WORKFLOW_ZONE_PADDING +
                index * LAYOUT_CONSTANTS.NODE_SPACING_X -
                9, // Center offset
              y:
                zoneY +
                LAYOUT_CONSTANTS.WORKFLOW_ZONE_HEADER_HEIGHT +
                LAYOUT_CONSTANTS.TASK_ZONE_Y_OFFSET,
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
      }

      // Update fallback position for next workflow (in case ELK hasn't run yet)
      fallbackY += zoneHeight + LAYOUT_CONSTANTS.WORKFLOW_ZONE_GAP;
    });

    return nodes;
  }, [
    workflows,
    workflowTasksMap,
    workflowStepsMap,
    elkPositions,
    handleTaskClick,
    selectedTaskId,
    handleStepClick,
    selectedStep,
    handleZoneClick,
    selectedZone,
    handleWorkflowClick,
    selectedWorkflow,
    isCollapsed,
  ]);

  // Generate edges for step transitions
  const allEdges = useMemo(() => {
    const edges: Edge[] = [];

    // Only generate step-to-step edges when expanded (not collapsed)
    if (!isCollapsed) {
      workflows.forEach((workflow) => {
        const workflowId = workflow.id;
        if (!workflowId) return;

        const workflowSteps = workflowStepsMap.get(workflowId) || [];

        // Create a map from step ID to step order for edge creation
        const stepIdToOrder = new Map<string, number>();
        workflowSteps.forEach((step) => {
          if (step.id) {
            stepIdToOrder.set(step.id, step.order);
          }
        });

        // Generate edges based on transitions_to
        workflowSteps.forEach((step) => {
          if (!step.id) return;

          // Guard against missing transitions_to array
          const transitions = step.transitions_to || [];
          transitions.forEach((targetStepId) => {
            const targetOrder = stepIdToOrder.get(targetStepId);
            if (targetOrder !== undefined) {
              edges.push({
                id: `edge-${workflowId}-${step.order}-${targetOrder}`,
                source: `step-${workflowId}-${step.order}`,
                target: `step-${workflowId}-${targetOrder}`,
                type: "smoothstep",
                animated: false,
                style: {
                  stroke: "rgba(99, 102, 241, 0.5)",
                  strokeWidth: 2,
                },
                markerEnd: {
                  type: MarkerType.ArrowClosed,
                  color: "rgba(99, 102, 241, 0.7)",
                  width: 20,
                  height: 20,
                },
              });
            }
          });
        });
      });
    }

    // Generate edges for workflow-to-workflow transitions (always shown)
    workflowTransitions
      .filter((t) => t.from_workflow_id !== t.to_workflow_id) // Skip self-transitions
      .forEach((transition, index) => {
        // Only use ELK edge paths when expanded - when collapsed, use smoothstep
        // which auto-connects to node handles at their scaled positions
        const elkEdgeId = `elk-edge-${index}`;
        const elkEdgePath = !isCollapsed
          ? elkEdgePaths.get(elkEdgeId)
          : undefined;

        edges.push({
          id: `workflow-transition-${transition.from_workflow_id}-${transition.to_workflow_id}`,
          source: `workflow-zone-${transition.from_workflow_id}`,
          target: `workflow-zone-${transition.to_workflow_id}`,
          type: elkEdgePath ? "elkRouted" : "smoothstep",
          animated: true,
          data: elkEdgePath
            ? ({
                sourcePoint: elkEdgePath.sourcePoint,
                targetPoint: elkEdgePath.targetPoint,
                bendPoints: elkEdgePath.bendPoints,
                label: transition.label,
              } as ElkRoutedEdgeData)
            : undefined,
          label: elkEdgePath ? undefined : transition.label,
          labelStyle: !elkEdgePath
            ? { fill: "#a1a1aa", fontSize: 11, fontWeight: 500 }
            : undefined,
          labelBgStyle: !elkEdgePath
            ? { fill: "#18181b", fillOpacity: 0.9 }
            : undefined,
          labelBgPadding: !elkEdgePath
            ? ([6, 3] as [number, number])
            : undefined,
          labelBgBorderRadius: !elkEdgePath ? 4 : undefined,
          style: {
            stroke: "rgba(251, 146, 60, 0.6)", // Orange for workflow transitions
            strokeWidth: 2,
            strokeDasharray: "5,5", // Dashed line to distinguish from step edges
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "rgba(251, 146, 60, 0.8)",
            width: 24,
            height: 24,
          },
        });
      });

    return edges;
  }, [
    workflows,
    workflowStepsMap,
    workflowTransitions,
    elkEdgePaths,
    isCollapsed,
  ]);

  const [nodes, setNodes, onNodesChange] = useNodesState(allNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(allEdges);

  // Update nodes when allNodes changes
  useEffect(() => {
    setNodes(allNodes);
  }, [allNodes, setNodes]);

  // Update edges when allEdges changes
  useEffect(() => {
    setEdges(allEdges);
  }, [allEdges, setEdges]);

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
          <div className="relative flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold text-text-primary">
                Workflow Pipelines
              </h1>
              <p className="mt-1 text-sm text-text-muted">
                {workflows.length} workflow{workflows.length !== 1 ? "s" : ""}{" "}
                visualized
              </p>
            </div>
            <button
              onClick={() => setIsCollapsed(prev => !prev)}
              className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                isCollapsed 
                  ? "bg-accent/20 text-accent hover:bg-accent/30" 
                  : "bg-bg-secondary text-text-muted hover:bg-bg-elevated"
              }`}
              title="Press 'c' to toggle"
            >
              {isCollapsed ? "Collapsed" : "Expanded"}
              <kbd className="rounded bg-bg-primary/50 px-1.5 py-0.5 text-[10px]">c</kbd>
            </button>
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
            edgeTypes={edgeTypes}
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

      {/* Workflow Detail Panel */}
      {selectedWorkflow && (
        <WorkflowDetailPanel
          workflow={selectedWorkflow}
          steps={workflowStepsMap.get(selectedWorkflow.id || "") || []}
          taskCount={
            workflowTasksMap.get(selectedWorkflow.id || "")?.length || 0
          }
          onClose={handleCloseWorkflowPanel}
        />
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
          const tasksByStep = groupTasksByStep(allWorkflowTasks, workflowSteps);
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

export function AllWorkflowsPipeline() {
  return (
    <ReactFlowProvider>
      <AllWorkflowsPipelineInner />
    </ReactFlowProvider>
  );
}
