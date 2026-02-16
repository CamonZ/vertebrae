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
} from "../bindings";
import { useStepChangeListener } from "../hooks/useStepChangeListener";
import { useElkLayout, type LayoutNode, type LayoutEdge } from "../hooks";
import { useToastStore } from "../stores";
import { useTaskStore } from "../stores";
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
function AllWorkflowsPipelineInner() {
  const addToast = useToastStore((state) => state.addToast);
  const { fitView } = useReactFlow();

  // Pipeline data loaded in a single batch
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowTasksMap, setWorkflowTasksMap] = useState<
    Map<string, Task[]>
  >(new Map());
  const [workflowStepsMap, setWorkflowStepsMap] = useState<Map<string, Step[]>>(
    new Map()
  );
  const [workflowTransitions, setWorkflowTransitions] = useState<
    WorkflowTransition[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Shared debounce timer for pipeline refetch - coalesces all WS event listeners
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // State for selected task (for detail panel)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // State for selected step ID (for step config panel)
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  // State for selected workflow (for workflow detail panel)
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(
    null
  );

  // State for collapsed view toggle (press 'c' to toggle)
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Track IDs that should flash (workflow zone + step node)
  const [flashingWorkflowIds, setFlashingWorkflowIds] = useState<Set<string>>(new Set());
  const [flashingStepIds, setFlashingStepIds] = useState<Set<string>>(new Set());

  // Task selection handlers
  const handleTaskClick = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    setSelectedStepId(null); // Clear step selection when task is selected
  }, []);

  const handleCloseTaskPanel = useCallback(() => {
    setSelectedTaskId(null);
  }, []);

  const handleRelatedTaskSelect = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    setSelectedStepId(null);
  }, []);

  // Step selection handlers
  const handleStepClick = useCallback((step: Step) => {
    setSelectedStepId(step.id || null);
    setSelectedTaskId(null); // Clear task selection when step is selected
    setSelectedWorkflow(null); // Clear workflow selection
  }, []);

  // Workflow selection handlers
  const handleWorkflowClick = useCallback((workflow: Workflow) => {
    setSelectedWorkflow(workflow);
    setSelectedTaskId(null); // Clear task selection
    setSelectedStepId(null); // Clear step selection
  }, []);

  const handleCloseWorkflowPanel = useCallback(() => {
    setSelectedWorkflow(null);
  }, []);

  const handleCloseStepPanel = useCallback(() => {
    setSelectedStepId(null);
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

  // Single fetch function that loads all pipeline data in one command
  const fetchPipelineData = useCallback(async () => {
    try {
      const result = await commands.getPipelineData();
      if (result.status === "ok") {
        const data = result.data;

        setWorkflows(data.workflows);

        // Push all tasks to the store so detail panel can derive relations
        useTaskStore.getState().setTasks(data.tasks);

        // Group tasks by workflow_id
        const tasksMap = new Map<string, Task[]>();
        for (const task of data.tasks) {
          const wfId = task.workflow_id;
          if (wfId) {
            if (!tasksMap.has(wfId)) tasksMap.set(wfId, []);
            tasksMap.get(wfId)!.push(task);
          }
        }
        setWorkflowTasksMap(tasksMap);

        // Steps are already grouped by workflow_id from the backend
        const stepsMap = new Map<string, Step[]>();
        for (const [wfId, steps] of Object.entries(data.workflow_steps)) {
          if (steps) {
            stepsMap.set(wfId, steps);
          }
        }
        setWorkflowStepsMap(stepsMap);

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

  // Debounced refetch - for structural changes (workflow/step CRUD)
  const schedulePipelineRefetch = useCallback(() => {
    if (refetchTimerRef.current) {
      clearTimeout(refetchTimerRef.current);
    }
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      fetchPipelineData();
    }, 200);
  }, [fetchPipelineData]);

  // Store fetchPipelineData in a ref to avoid dependency cycles
  const fetchPipelineDataRef = useRef(fetchPipelineData);
  useEffect(() => {
    fetchPipelineDataRef.current = fetchPipelineData;
  }, [fetchPipelineData]);

  // Handle step updates (refetch all data)
  const handleStepUpdated = useCallback(async () => {
    await fetchPipelineDataRef.current();
  }, []);

  // Handle step deletion (refetch and close panel)
  const handleStepDeleted = useCallback(async () => {
    await fetchPipelineDataRef.current();
    setSelectedStepId(null);
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchPipelineData();
  }, [fetchPipelineData]);

  // Handle individual task changes - fetch only the changed task and patch local state
  useEffect(() => {
    const unlistenPromise = events.taskChangedEvent.listen(async (event) => {
      const { task_id, change_type } = event.payload;

      if (change_type === "Deleted") {
        // Remove task from the map
        setWorkflowTasksMap((prev) => {
          const next = new Map(prev);
          for (const [wfId, tasks] of next) {
            const filtered = tasks.filter((t) => t.id !== task_id);
            if (filtered.length !== tasks.length) {
              next.set(wfId, filtered);
            }
          }
          return next;
        });
        return;
      }

      // Fetch just the changed task
      try {
        const result = await commands.getTask(task_id);
        if (result.status !== "ok") return;
        const updatedTask = result.data;

        // Update the task store for detail panel
        const store = useTaskStore.getState();
        const updatedTasks = store.tasks.map((t) =>
          t.id === task_id ? updatedTask : t
        );
        // If task wasn't in the list (newly created), add it
        if (!store.tasks.some((t) => t.id === task_id)) {
          updatedTasks.push(updatedTask);
        }
        store.setTasks(updatedTasks);

        // Patch the workflowTasksMap
        setWorkflowTasksMap((prev) => {
          const next = new Map(prev);

          // Remove task from its old workflow bucket (if it moved)
          for (const [wfId, tasks] of next) {
            const idx = tasks.findIndex((t) => t.id === task_id);
            if (idx !== -1) {
              const updated = [...tasks];
              updated.splice(idx, 1);
              next.set(wfId, updated);
            }
          }

          // Add task to its current workflow bucket
          const wfId = updatedTask.workflow_id;
          if (wfId) {
            const bucket = next.get(wfId) || [];
            next.set(wfId, [...bucket, updatedTask]);
          }

          return next;
        });

        // Trigger flash animation on workflow and step assignment
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
      } catch {
        // Fallback to full refetch on error
        schedulePipelineRefetch();
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [schedulePipelineRefetch]);

  // Subscribe to workflow change events - only refetch for known workflows
  useEffect(() => {
    const unlistenPromise = events.workflowChangedEvent.listen((event) => {
      const { workflow_id } = event.payload;
      // Ignore events where the ID doesn't match any known workflow
      // (backend bug: sometimes sends task_id as workflow_id)
      const isKnownWorkflow = workflows.some((w) => w.id === workflow_id);
      if (isKnownWorkflow) {
        schedulePipelineRefetch();
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [workflows, schedulePipelineRefetch]);

  // Subscribe to step change events - reload pipeline when steps are added/updated/deleted
  useStepChangeListener(null, {
    onWorkflowStepsChange: schedulePipelineRefetch,
  });

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
      const sortedSteps = [...workflowSteps].sort((a, b) => a.order - b.order);
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
              taskCounts,
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
        />
      )}

      {/* Step Detail Panel */}
      {selectedStepId && (
        <StepDetailPanel
          stepId={selectedStepId}
          allSteps={Array.from(workflowStepsMap.values()).flat()}
          tasks={stepTasksData.stepTasks}
          onTaskSelect={handleRelatedTaskSelect}
          selectedTaskId={selectedTaskId}
          onClose={handleCloseStepPanel}
          onUpdated={handleStepUpdated}
          onDeleted={handleStepDeleted}
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
          tasks={
            workflowTasksMap
              .get(selectedWorkflow.id || "")
              ?.map((t) => ({ id: t.id, title: t.title })) || []
          }
          onClose={handleCloseWorkflowPanel}
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
