import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  commands,
  events,
  type Task,
  type Step,
  type Workflow,
  type WorkflowTransition,
  type StepExecutionStatus,
  type ExecutionStatus,
} from "../bindings";
import { useElkLayout, type LayoutNode, type LayoutEdge } from "../hooks";
import { useToastStore, useTaskStore, useExecutionStore, useWorkflowStore, useStepStore } from "../stores";
import { groupTasksByStep } from "../utils";
import {
  StepNode,
  type StepNodeData,
  WorkflowZoneNode,
  type WorkflowZoneNodeData,
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

/**
 * Node type mapping for React Flow
 */
const nodeTypes: NodeTypes = {
  stepNode: StepNode,
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

/** Map API ExecutionStatus to frontend StepExecutionStatus */
function mapExecutionStatus(status: ExecutionStatus): StepExecutionStatus {
  switch (status) {
    case "in_progress": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
  }
}

type PanelEntry =
  | { type: 'task'; id: string }
  | { type: 'step'; id: string }
  | { type: 'workflow'; id: string };

function AllWorkflowsPipelineInner() {
  const addToast = useToastStore((state) => state.addToast);
  const { fitView } = useReactFlow();

  // Read entity lists from global Zustand stores (kept fresh by GlobalListeners)
  const workflows = useWorkflowStore((state) => state.workflows);
  const allTasks = useTaskStore((state) => state.tasks);
  const allSteps = useStepStore((state) => state.steps);

  // Derive workflowTasksMap from the task store
  const workflowTasksMap = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of allTasks) {
      const wfId = task.workflow_id;
      if (wfId) {
        if (!map.has(wfId)) map.set(wfId, []);
        map.get(wfId)!.push(task);
      }
    }
    return map;
  }, [allTasks]);

  // Derive workflowStepsMap from the step store
  const workflowStepsMap = useMemo(() => {
    const map = new Map<string, Step[]>();
    for (const step of allSteps) {
      if (step.workflow_id) {
        if (!map.has(step.workflow_id)) map.set(step.workflow_id, []);
        map.get(step.workflow_id)!.push(step);
      }
    }
    return map;
  }, [allSteps]);

  // Transitions stay as local state (Sacrum does not broadcast transition events)
  const [workflowTransitions, setWorkflowTransitions] = useState<
    WorkflowTransition[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // State for selected task (for detail panel)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // State for selected step ID (for step config panel)
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  // State for selected workflow ID (derive full object from store for live updates)
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const selectedWorkflow = useMemo(
    () => workflows.find((w) => w.id === selectedWorkflowId) ?? null,
    [workflows, selectedWorkflowId]
  );

  // Panel navigation history stack
  const [panelHistory, setPanelHistory] = useState<PanelEntry[]>([]);

  // State for collapsed view toggle (press 'c' to toggle)
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Track IDs that should flash (workflow zone + step node)
  const [flashingWorkflowIds, setFlashingWorkflowIds] = useState<Set<string>>(new Set());
  const [flashingStepIds, setFlashingStepIds] = useState<Set<string>>(new Set());

  // Derive per-task execution state from the execution store
  const executions = useExecutionStore((state) => state.executions);
  const taskExecutionStates = useMemo(() => {
    const map = new Map<string, { status: StepExecutionStatus; stepName: string }>();
    for (const exec of executions) {
      if (exec.task_id && exec.status) {
        map.set(exec.task_id, {
          status: mapExecutionStatus(exec.status),
          stepName: exec.step_name ?? "",
        });
      }
    }
    return map;
  }, [executions]);

  // Helper to capture current panel state
  function currentPanelEntry(): PanelEntry | null {
    if (selectedTaskId) return { type: 'task', id: selectedTaskId };
    if (selectedStepId) return { type: 'step', id: selectedStepId };
    if (selectedWorkflowId) return { type: 'workflow', id: selectedWorkflowId };
    return null;
  }

  // Task selection handlers
  const handleTaskClick = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    setSelectedStepId(null); // Clear step selection when task is selected
    setPanelHistory([]); // Canvas click — fresh navigation
  }, []);

  const handleCloseTaskPanel = useCallback(() => {
    setSelectedTaskId(null);
    setPanelHistory([]); // Explicit close — clear history
  }, []);

  const handleRelatedTaskSelect = useCallback((taskId: string) => {
    // Push current panel onto history before switching (in-panel navigation)
    const current = currentPanelEntry();
    if (current) {
      setPanelHistory(prev => [...prev, current]);
    }
    setSelectedTaskId(taskId);
    setSelectedStepId(null);
    setSelectedWorkflowId(null);
  }, [selectedTaskId, selectedStepId, selectedWorkflowId]);

  // Step selection handlers
  const handleStepClick = useCallback((step: Step) => {
    setSelectedStepId(step.id || null);
    setSelectedTaskId(null); // Clear task selection when step is selected
    setSelectedWorkflowId(null); // Clear workflow selection
    setPanelHistory([]); // Canvas click — fresh navigation
  }, []);

  // Workflow selection handlers
  const handleWorkflowClick = useCallback((workflow: Workflow) => {
    setSelectedWorkflowId(workflow.id || null);
    setSelectedTaskId(null); // Clear task selection
    setSelectedStepId(null); // Clear step selection
    setPanelHistory([]); // Canvas click — fresh navigation
  }, []);

  const handleCloseWorkflowPanel = useCallback(() => {
    setSelectedWorkflowId(null);
    setPanelHistory([]); // Explicit close — clear history
  }, []);

  const handleCloseStepPanel = useCallback(() => {
    setSelectedStepId(null);
    setPanelHistory([]); // Explicit close — clear history
  }, []);

  // Handle step selection from workflow detail panel (in-panel navigation)
  const handleWorkflowStepSelect = useCallback((step: Step) => {
    // Push current workflow panel onto history
    if (selectedWorkflowId) {
      setPanelHistory(prev => [...prev, { type: 'workflow', id: selectedWorkflowId }]);
    }
    setSelectedStepId(step.id || null);
    setSelectedWorkflowId(null);
    setSelectedTaskId(null);
  }, [selectedWorkflowId]);

  // Navigate back through panel history
  const handleBack = useCallback(() => {
    setPanelHistory(prev => {
      const newHistory = [...prev];
      const entry = newHistory.pop();
      if (!entry) return prev;

      // Restore the previous panel
      if (entry.type === 'task') {
        setSelectedTaskId(entry.id);
        setSelectedStepId(null);
        setSelectedWorkflowId(null);
      } else if (entry.type === 'step') {
        setSelectedStepId(entry.id);
        setSelectedTaskId(null);
        setSelectedWorkflowId(null);
      } else if (entry.type === 'workflow') {
        setSelectedWorkflowId(entry.id);
        setSelectedTaskId(null);
        setSelectedStepId(null);
      }

      return newHistory;
    });
  }, []);

  // Compute stepTasks when selectedStepId changes
  const stepTasksData = useMemo(() => {
    if (!selectedStepId) return { stepTasks: [], workflowId: "" };

    // Find which workflow the selected step belongs to
    let workflowId = "";
    for (const [wfId, steps] of workflowStepsMap) {
      if (steps.some((s) => s.id === selectedStepId)) {
        workflowId = wfId;
        break;
      }
    }

    if (!workflowId) return { stepTasks: [], workflowId: "" };

    // Get tasks for this workflow
    const workflowTasks = workflowTasksMap.get(workflowId) || [];
    const workflowSteps = workflowStepsMap.get(workflowId) || [];

    if (workflowSteps.length === 0) {
      return { stepTasks: [], workflowId };
    }

    // Group tasks by step and get tasks for the selected step
    const tasksByStep = groupTasksByStep(workflowTasks, workflowSteps);
    const selectedStep = workflowSteps.find((s) => s.id === selectedStepId);
    const stepName = selectedStep?.name.toLowerCase();
    const stepTasks = stepName ? tasksByStep.get(stepName) || [] : [];

    return { stepTasks, workflowId };
  }, [selectedStepId, workflowStepsMap, workflowTasksMap]);

  // Seed the Zustand stores and fetch transitions on mount
  const fetchPipelineData = useCallback(async () => {
    try {
      const result = await commands.getPipelineData();
      if (result.status === "ok") {
        const data = result.data;

        // Seed global stores — GlobalListeners keeps them fresh after this
        useWorkflowStore.getState().setWorkflows(data.workflows);
        useTaskStore.getState().setTasks(data.tasks);

        // Flatten workflow_steps into a single step array for the store
        const allStepsArr: Step[] = [];
        for (const steps of Object.values(data.workflow_steps)) {
          if (steps) allStepsArr.push(...steps);
        }
        useStepStore.getState().setSteps(allStepsArr);

        // Transitions stay local (no WS broadcast)
        setWorkflowTransitions(data.transitions);
        setError(null);
      } else {
        setError(result.error.message);
        addToast(`Failed to load pipeline data: ${result.error.message}`, "error");
      }
    } catch (err) {
      const msg = String(err);
      setError(msg);
      addToast(`Failed to load pipeline data: ${msg}`, "error");
    } finally {
      setIsLoading(false);
    }
  }, [addToast]);

  // Initial fetch
  useEffect(() => {
    fetchPipelineData();
  }, [fetchPipelineData]);

  // Seed execution store from API after the initial pipeline data loads
  const setExecutions = useExecutionStore((state) => state.setExecutions);
  const executionSeeded = useRef(false);
  useEffect(() => {
    if (executionSeeded.current || allTasks.length === 0) return;
    executionSeeded.current = true;

    const taskIds = allTasks.map((t) => t.id);
    Promise.allSettled(
      taskIds.map((taskId) =>
        commands
          .getTaskExecutions(taskId)
          .then((result) => ({ taskId, result }))
      )
    ).then((outcomes) => {
      const latestExecutions = [];
      for (const outcome of outcomes) {
        if (outcome.status !== "fulfilled") continue;
        const { result } = outcome.value;
        if (result.status !== "ok" || result.data.length === 0) continue;
        latestExecutions.push(result.data[result.data.length - 1]);
      }
      if (latestExecutions.length > 0) {
        setExecutions(latestExecutions);
      }
    });
  }, [allTasks, setExecutions]);

  // Flash animations on task changes (UI-only, no entity state management)
  useEffect(() => {
    const unlistenPromise = events.taskChangedEvent.listen((event) => {
      const { change_type, task: updatedTask } = event.payload;
      if (change_type === "Deleted" || !updatedTask) return;

      const wfId = updatedTask.workflow_id;
      const stepId = updatedTask.current_step_id;

      if (wfId) {
        setFlashingWorkflowIds((prev) => new Set(prev).add(wfId));
        setTimeout(() => {
          setFlashingWorkflowIds((prev) => {
            const next = new Set(prev);
            next.delete(wfId);
            return next;
          });
        }, 2000);
      }

      if (stepId) {
        setFlashingStepIds((prev) => new Set(prev).add(stepId));
        setTimeout(() => {
          setFlashingStepIds((prev) => {
            const next = new Set(prev);
            next.delete(stepId);
            return next;
          });
        }, 2000);
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Calculate workflow zone dimensions for ELK layout
  const workflowDimensions = useMemo(() => {
    const dimensions = new Map<string, { width: number; height: number }>();
    workflows.forEach((workflow) => {
      if (!workflow.id) return;
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
      const sortedSteps = [...workflowSteps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const workflowTasks = workflowTasksMap.get(workflowId) || [];
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
        // Explicit dimensions so React Flow skips the visibility:hidden phase
        // while waiting for ResizeObserver measurement.
        width: zoneWidth,
        height: zoneHeight,
        data: {
          workflow,
          taskCount: workflowTasks.length,
          stepCount: sortedSteps.length,
          width: zoneWidth,
          height: zoneHeight,
          onWorkflowClick: handleWorkflowClick,
          isWorkflowSelected: selectedWorkflow?.id === workflowId,
          isCollapsed,
          isFlashing: flashingWorkflowIds.has(workflowId),
        } as WorkflowZoneNodeData,
        draggable: false,
        selectable: false,
      });

      // Only add step and task nodes when expanded (not collapsed)
      if (!isCollapsed) {
        // Add step nodes within this workflow zone
        const tasksByStep = groupTasksByStep(workflowTasks, sortedSteps);

        sortedSteps.forEach((step, index) => {
          const isStepSelected = selectedStepId === step.id;
          
          // Compute task counts for this step
          const stepTasks = tasksByStep.get(step.name.toLowerCase()) || [];
          const taskCounts = { epic: 0, ticket: 0, task: 0 };
          stepTasks.forEach((t) => {
            if (t.level === "epic") taskCounts.epic++;
            else if (t.level === "ticket") taskCounts.ticket++;
            else taskCounts.task++;
          });

          // Compute execution counts for this step
          const executionCounts = { running: 0, completed: 0, failed: 0 };
          stepTasks.forEach((t) => {
            const execState = taskExecutionStates.get(t.id);
            if (execState) {
              if (execState.status === "Running") executionCounts.running++;
              else if (execState.status === "Completed") executionCounts.completed++;
              else if (execState.status === "Failed") executionCounts.failed++;
            }
          });

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
            width: LAYOUT_CONSTANTS.STEP_NODE_WIDTH,
            height: LAYOUT_CONSTANTS.STEP_NODE_HEIGHT,
            data: {
              step,
              isFirst: index === 0,
              isLast: index === sortedSteps.length - 1,
              onStepClick: handleStepClick,
              isSelected: isStepSelected,
              taskCounts,
              executionCounts,
              isFlashing: step.id ? flashingStepIds.has(step.id) : false,
            } as StepNodeData,
            draggable: false,
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
    selectedStepId,
    handleWorkflowClick,
    selectedWorkflow,
    isCollapsed,
    flashingWorkflowIds,
    flashingStepIds,
    taskExecutionStates,
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
            stepIdToOrder.set(step.id, step.order ?? 0);
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

  // Track whether initial fitView has fired
  const hasFittedRef = useRef(false);

  // Update nodes when allNodes changes
  useEffect(() => {
    setNodes(allNodes);
  }, [allNodes, setNodes]);

  // Fit view only once on initial load
  useEffect(() => {
    if (!hasFittedRef.current && allNodes.length > 0) {
      hasFittedRef.current = true;
      requestAnimationFrame(() => {
        fitView({ padding: 0.1, minZoom: 0.3, maxZoom: 1.5 });
      });
    }
  }, [allNodes, fitView]);

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
          onClick={fetchPipelineData}
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
          onBack={panelHistory.length > 0 ? handleBack : undefined}
        />
      )}

      {/* Step Detail Panel */}
      {selectedStepId && (
        <StepDetailPanel
          stepId={selectedStepId}
          allSteps={allSteps}
          tasks={stepTasksData.stepTasks}
          onTaskSelect={handleRelatedTaskSelect}
          selectedTaskId={selectedTaskId}
          onClose={handleCloseStepPanel}
          onDeleted={handleCloseStepPanel}
          taskExecutionStates={taskExecutionStates}
          onBack={panelHistory.length > 0 ? handleBack : undefined}
        />
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
          onStepSelect={handleWorkflowStepSelect}
          onBack={panelHistory.length > 0 ? handleBack : undefined}
        />
      )}
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
