import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
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
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  commands,
  events,
  type Step,
  type Workflow,
  type StepType,
  type AgentConfig,
  type SessionLog,
  type TaskFilterOptions,
  type TaskRunStatus,
  type WorkflowTransition,
} from "../bindings";
import {
  useElkLayout,
  type LayoutNode,
  type LayoutEdge,
  usePipelineSummary,
  useTaskRunTrace,
  useStepTasks,
  useTasks,
} from "../hooks";
import type {
  PipelineStep,
  PipelineWorkflow,
} from "../hooks/usePipelineSummary";
import { useTaskStore, useToastStore } from "../stores";
import { FormModal } from "../components/forms/FormModal";
import {
  StepNode,
  type StepNodeData,
  WorkflowZoneNode,
  type WorkflowZoneNodeData,
  ElkRoutedEdge,
  type ElkRoutedEdgeData,
  RouteBackEdge,
  ROUTE_BACK_EDGE_TYPE,
  transitionArrowMarker,
  transitionEdgeStyle,
  TransitionEdgeMarkers,
  LAYOUT_CONSTANTS,
  calculateWorkflowZoneWidth,
  calculateWorkflowZoneHeight,
} from "../components/WorkflowPipeline";
import { TaskDetailPanel } from "../components/TaskDetail";
import { StepDetailPanel } from "../components/StepDetail";
import { WorkflowDetailPanel } from "../components/WorkflowDetail";
import { IdentityBadge } from "../components/shared/EntityId";
import { Count } from "../components/atoms";
import { UnifiedChatView, projectTaskRunTrace } from "../components/Traces";
import { popOut } from "../utils";
import { useShellHeader } from "../hooks/useShellHeader";
import { CanvasMiniMap } from "../components/WorkflowPipeline/overlays";
import { isEditableShortcutTarget } from "../utils/keyboard";
import {
  deriveActiveTaskRuns,
  deriveRunControlsState,
  runStatusLabel,
  type ActiveTaskRun,
} from "../utils/runState";

const nodeTypes: NodeTypes = {
  stepNode: StepNode,
  workflowZoneNode: WorkflowZoneNode,
};

const edgeTypes: EdgeTypes = {
  elkRouted: ElkRoutedEdge,
  [ROUTE_BACK_EDGE_TYPE]: RouteBackEdge,
};

const EMPTY_AGENT_CONFIG: AgentConfig = {
  model: null,
  fallback_model: null,
  reasoning_effort: null,
  system_prompt: null,
  append_system_prompt: null,
  agents: null,
  tools: [],
  allowed_tools: [],
  disallowed_tools: [],
  permission_mode: null,
  max_budget_usd: null,
  mcp_config: [],
  plugin_dirs: [],
  json_schema: null,
};
const EXECUTE_STEP_TYPE: StepType = "execute";
const EMPTY_PIPELINE_WORKFLOWS: PipelineWorkflow[] = [];
const PIPELINE_FLASH_DURATION_MS = 250;
const PIPELINE_TASK_FILTER: TaskFilterOptions = {
  step_names: null,
  levels: null,
  tags: null,
  root_only: null,
  children_of: null,
  search: null,
  workflow_id: null,
  step_id: null,
};

function pipelineStepToStep(step: PipelineStep): Step {
  return {
    id: step.id,
    name: step.name,
    workflow_id: step.workflow_id,
    goal: step.goal,
    prompt: null,
    agents: [],
    skills: [],
    agent_config: EMPTY_AGENT_CONFIG,
    step_type: (step.step_type as StepType | null) ?? EXECUTE_STEP_TYPE,
    output_schema: null,
    is_final: step.is_final,
    transitions_to: step.transitions_to,
    order: step.step_order,
    created_at: null,
    updated_at: null,
  };
}

function pipelineWorkflowToWorkflow(wf: PipelineWorkflow): Workflow {
  return {
    id: wf.id,
    name: wf.name,
    description: wf.description,
    initial_step: wf.initial_step_id,
    kanban_column: wf.kanban_column,
    is_default: wf.is_default,
    is_final: wf.is_final,
    metadata: {},
    created_at: null,
    updated_at: null,
  };
}

type PanelEntry =
  | { type: "task"; id: string }
  | { type: "step"; id: string }
  | { type: "workflow"; id: string };

const EMPTY_FLASHING_EDGE_IDS = new Set<string>();

type RenderableWorkflowTransition = {
  transition: WorkflowTransition;
  elkEdgeId: string;
};

type PipelinePanelTab = "ready" | "running";
type StepTypeById = Map<string, string | null>;

type PipelineRunIndicator = {
  label: string;
  dotClass: string;
  pulse: boolean;
};

function runningIndicatorForTask(
  task: ActiveTaskRun["task"],
  status: TaskRunStatus,
  stepTypeById: StepTypeById
): PipelineRunIndicator {
  switch (status) {
    case "queued":
      return { label: "Queued", dotClass: "bg-sky-400", pulse: false };
    case "executing":
      return { label: "Running", dotClass: "bg-success", pulse: false };
    case "waiting": {
      const stepType = task.current_step_id
        ? stepTypeById.get(task.current_step_id)
        : null;
      if (stepType === "wait_children") {
        return {
          label: "Waiting on children",
          dotClass: "bg-sky-400",
          pulse: true,
        };
      }
      if (stepType === "human_input") {
        return {
          label: "Waiting for human input",
          dotClass: "bg-warning",
          pulse: false,
        };
      }
      return { label: "Waiting", dotClass: "bg-sky-400", pulse: false };
    }
    case "stopping":
      return { label: "Stopping", dotClass: "bg-text-muted", pulse: true };
    default:
      return {
        label: runStatusLabel(status),
        dotClass: "bg-text-muted",
        pulse: false,
      };
  }
}

function useActivePipelineRuns(): ActiveTaskRun[] {
  const tasks = useTaskStore((state) => state.tasks);

  return useMemo(() => {
    const activeRuns = deriveActiveTaskRuns(tasks, { sortNewestFirst: true });
    const activeTaskIds = new Set(activeRuns.map(({ task }) => task.id));
    return activeRuns.filter(({ task }) => {
      return !task.parent_id || !activeTaskIds.has(task.parent_id);
    });
  }, [tasks]);
}

function useReadyPipelineTasks(): ActiveTaskRun["task"][] {
  const tasks = useTaskStore((state) => state.tasks);

  return useMemo(() => {
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    return tasks.filter((task) => {
      if (task.archived || task.completed_at) return false;
      if (task.run_controls?.active_run) return false;
      if (task.run_controls && task.run_controls.runnable !== true) {
        return false;
      }
      if (!task.run_controls && !task.workflow_id) return false;
      const deps = task.dependency_ids ?? [];
      return deps.every((depId) => {
        const dep = taskMap.get(depId);
        if (!dep) return false;
        const depRunStatus = dep.run_controls?.active_run?.status ?? null;
        if (depRunStatus === "completed") return true;
        return dep.step_name === "done";
      });
    });
  }, [tasks]);
}

function useTasksByParentId(): Map<string, ActiveTaskRun["task"][]> {
  const tasks = useTaskStore((state) => state.tasks);

  return useMemo(() => {
    const byParentId = new Map<string, ActiveTaskRun["task"][]>();
    for (const task of tasks) {
      if (!task.parent_id) continue;
      if (task.completed_at) continue;
      const childTasks = byParentId.get(task.parent_id) ?? [];
      childTasks.push(task);
      byParentId.set(task.parent_id, childTasks);
    }
    return byParentId;
  }, [tasks]);
}

function stepEdgeId(
  workflowId: string,
  sourceStepId: string,
  targetStepId: string
) {
  return `edge-${workflowId}-${sourceStepId}-${targetStepId}`;
}

export function buildStepTransitionEdges(
  pipelineWorkflows: PipelineWorkflow[],
  flashingEdgeIds: Set<string> = EMPTY_FLASHING_EDGE_IDS,
  selectedEdgeId: string | null = null
): Edge[] {
  const edges: Edge[] = [];

  for (const wf of pipelineWorkflows) {
    const wfSteps = wf.workflow_steps;
    let routeBackEdgeIndex = 0;
    const stepIdToOrder = new Map<string, number>();
    wfSteps.forEach((s) => {
      stepIdToOrder.set(s.id, s.step_order);
    });
    wfSteps.forEach((s) => {
      s.transitions_to.forEach((targetStepId) => {
        const targetOrder = stepIdToOrder.get(targetStepId);
        if (targetOrder !== undefined) {
          const edgeId = stepEdgeId(wf.id, s.id, targetStepId);
          const isSelected = selectedEdgeId === edgeId;
          const isFlashing = flashingEdgeIds.has(edgeId);
          const isHighlighted = isSelected || isFlashing;
          const isRouteBackTransition =
            s.step_type === "route" && targetOrder < s.step_order;
          const routeBackLoopLane = Math.floor(routeBackEdgeIndex / 2);
          const routeBackLoopSide =
            routeBackEdgeIndex % 2 === 0 ? "bottom" : "top";
          edges.push({
            id: edgeId,
            source: `step-${wf.id}-${s.step_order}`,
            target: `step-${wf.id}-${targetOrder}`,
            selected: isSelected,
            selectable: true,
            type: isRouteBackTransition ? ROUTE_BACK_EDGE_TYPE : "smoothstep",
            animated: false,
            data: isRouteBackTransition
              ? {
                  loopLane: routeBackLoopLane,
                  loopSide: routeBackLoopSide,
                }
              : undefined,
            style: transitionEdgeStyle({
              selected: isHighlighted,
              dashed: isRouteBackTransition,
            }),
            markerEnd: transitionArrowMarker({ selected: isHighlighted }),
            interactionWidth: 20,
          });
          if (isRouteBackTransition) {
            routeBackEdgeIndex += 1;
          }
        }
      });
    });
  }

  return edges;
}

export function buildRenderableWorkflowTransitions(
  workflowTransitions: WorkflowTransition[]
): RenderableWorkflowTransition[] {
  return workflowTransitions
    .filter((t) => t.from_workflow_id !== t.to_workflow_id)
    .map((transition, index) => ({
      transition,
      elkEdgeId: `elk-edge-${index}`,
    }));
}

function AllWorkflowsPipelineInner() {
  const addToast = useToastStore((state) => state.addToast);
  const { fitView } = useReactFlow();

  useShellHeader("Design");

  const { summary, isLoading, error, refetch } = usePipelineSummary();

  // Surface fetch errors via a toast so the existing UX matches.
  useEffect(() => {
    if (error) {
      addToast(`Failed to load pipeline data: ${error}`, "error");
    }
  }, [error, addToast]);

  const pipelineWorkflows = summary?.workflows ?? EMPTY_PIPELINE_WORKFLOWS;

  // Synthetic frontend entities for the detail panels and node data.
  const workflows: Workflow[] = useMemo(
    () => pipelineWorkflows.map(pipelineWorkflowToWorkflow),
    [pipelineWorkflows]
  );

  const workflowStepsMap = useMemo(() => {
    const map = new Map<string, Step[]>();
    for (const wf of pipelineWorkflows) {
      map.set(
        wf.id,
        wf.workflow_steps
          .map(pipelineStepToStep)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      );
    }
    return map;
  }, [pipelineWorkflows]);

  const allSteps: Step[] = useMemo(() => {
    const out: Step[] = [];
    for (const steps of workflowStepsMap.values()) out.push(...steps);
    return out;
  }, [workflowStepsMap]);

  const stepTypeById = useMemo<StepTypeById>(() => {
    const map: StepTypeById = new Map();
    for (const workflow of pipelineWorkflows) {
      for (const step of workflow.workflow_steps) {
        map.set(step.id, step.step_type);
      }
    }
    return map;
  }, [pipelineWorkflows]);

  // Per-step aggregates from the pipeline summary, keyed by step id.
  const stepAggregates = useMemo(() => {
    const map = new Map<
      string,
      {
        taskCounts: { epic: number; ticket: number; task: number };
        active: number;
      }
    >();
    for (const wf of pipelineWorkflows) {
      for (const step of wf.workflow_steps) {
        map.set(step.id, {
          taskCounts: {
            epic: step.pipeline_counts.epic,
            ticket: step.pipeline_counts.ticket,
            task: step.pipeline_counts.task,
          },
          active: step.pipeline_counts.active,
        });
      }
    }
    return map;
  }, [pipelineWorkflows]);

  const workflowTaskCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const wf of pipelineWorkflows) {
      let total = 0;
      for (const step of wf.workflow_steps) {
        total +=
          step.pipeline_counts.epic +
          step.pipeline_counts.ticket +
          step.pipeline_counts.task;
      }
      map.set(wf.id, total);
    }
    return map;
  }, [pipelineWorkflows]);

  // Inter-workflow transitions for both ELK and React Flow rendering.
  const workflowTransitions: WorkflowTransition[] = useMemo(() => {
    const nameById = new Map<string, string>();
    for (const wf of pipelineWorkflows) nameById.set(wf.id, wf.name);
    const out: WorkflowTransition[] = [];
    for (const wf of pipelineWorkflows) {
      for (const t of wf.transitions) {
        out.push({
          id: t.id,
          from_workflow_id: t.from_workflow_id,
          from_workflow_name:
            nameById.get(t.from_workflow_id) ?? t.from_workflow_id,
          to_workflow_id: t.to_workflow_id,
          to_workflow_name: nameById.get(t.to_workflow_id) ?? t.to_workflow_id,
          label: t.label,
          target_step_id: t.target_step_id,
        });
      }
    }
    return out;
  }, [pipelineWorkflows]);

  // Selection state
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  // On-demand per-step task fetch — only triggers when a step is selected.
  // Keeps the page from doing a project-wide listTasks on mount.
  const { tasks: stepTasks } = useStepTasks(selectedStepId);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(
    null
  );
  const selectedWorkflow = useMemo(
    () => workflows.find((w) => w.id === selectedWorkflowId) ?? null,
    [workflows, selectedWorkflowId]
  );

  const [panelHistory, setPanelHistory] = useState<PanelEntry[]>([]);
  const [selectedTransitionEdgeId, setSelectedTransitionEdgeId] = useState<
    string | null
  >(null);
  const [pendingTransition, setPendingTransition] = useState<{
    from: string;
    to: string;
  } | null>(null);
  const [pendingLabel, setPendingLabel] = useState("");
  const [pendingTargetStepId, setPendingTargetStepId] = useState<string>("");
  const [isCreatingTransition, setIsCreatingTransition] = useState(false);
  const [createTransitionError, setCreateTransitionError] = useState<
    string | undefined
  >(undefined);

  const selectedTransition = useMemo(() => {
    if (!selectedTransitionEdgeId) return null;
    return (
      workflowTransitions.find(
        (tr) =>
          `workflow-transition-${tr.from_workflow_id}-${tr.to_workflow_id}` ===
          selectedTransitionEdgeId
      ) ?? null
    );
  }, [selectedTransitionEdgeId, workflowTransitions]);

  const handleCreateTransition = useCallback(
    async (
      fromWorkflowId: string,
      toWorkflowId: string,
      label: string,
      targetStepId: string | null
    ): Promise<boolean> => {
      setIsCreatingTransition(true);
      setCreateTransitionError(undefined);
      const result = await commands.createWorkflowTransition(
        fromWorkflowId,
        toWorkflowId,
        label.trim().length > 0 ? label.trim() : null,
        targetStepId && targetStepId.length > 0 ? targetStepId : null
      );
      setIsCreatingTransition(false);
      if (result.status === "error") {
        setCreateTransitionError(result.error.message);
        return false;
      }
      addToast("Transition created", "success");
      return true;
    },
    [addToast]
  );

  const handleDeleteTransition = useCallback(
    async (fromWorkflowId: string, toWorkflowId: string) => {
      const result = await commands.deleteWorkflowTransition(
        fromWorkflowId,
        toWorkflowId
      );
      if (result.status === "error") {
        addToast(result.error.message, "error");
        return;
      }
      setSelectedTransitionEdgeId(null);
      addToast("Transition deleted", "success");
    },
    [addToast]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const sourceMatch = connection.source?.match(/^workflow-zone-(.+)$/);
      const targetMatch = connection.target?.match(/^workflow-zone-(.+)$/);
      if (!sourceMatch || !targetMatch) return;
      const fromId = sourceMatch[1];
      const toId = targetMatch[1];
      if (fromId === toId) {
        addToast(
          "Cannot create a transition from a workflow to itself",
          "error"
        );
        return;
      }
      setPendingTransition({ from: fromId, to: toId });
      setPendingLabel("");
      setPendingTargetStepId("");
      setCreateTransitionError(undefined);
    },
    [addToast]
  );

  const selectedTransitionRef = useRef(selectedTransition);
  selectedTransitionRef.current = selectedTransition;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableShortcutTarget(e.target)) {
        return;
      }
      const tr = selectedTransitionRef.current;
      if ((e.key === "Delete" || e.key === "Backspace") && tr) {
        e.preventDefault();
        void handleDeleteTransition(tr.from_workflow_id, tr.to_workflow_id);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleDeleteTransition]);

  const highlightedTransitionWorkflowIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedTransitionEdgeId) return ids;
    const t = workflowTransitions.find(
      (tr) =>
        `workflow-transition-${tr.from_workflow_id}-${tr.to_workflow_id}` ===
        selectedTransitionEdgeId
    );
    if (t) {
      ids.add(t.from_workflow_id);
      ids.add(t.to_workflow_id);
    }
    return ids;
  }, [selectedTransitionEdgeId, workflowTransitions]);

  const [flashingWorkflowIds, setFlashingWorkflowIds] = useState<Set<string>>(
    new Set()
  );
  const [flashingStepIds, setFlashingStepIds] = useState<Set<string>>(
    new Set()
  );
  const [flashingEdgeIds, setFlashingEdgeIds] = useState<Set<string>>(
    new Set()
  );

  const stepLocationByStepId = useMemo(() => {
    const map = new Map<string, { workflowId: string; order: number }>();
    for (const [wfId, steps] of workflowStepsMap.entries()) {
      for (const s of steps) {
        if (s.id) map.set(s.id, { workflowId: wfId, order: s.order ?? 0 });
      }
    }
    return map;
  }, [workflowStepsMap]);
  const stepLocationRef = useRef(stepLocationByStepId);
  useEffect(() => {
    stepLocationRef.current = stepLocationByStepId;
  }, [stepLocationByStepId]);

  function currentPanelEntry(): PanelEntry | null {
    if (selectedTaskId) return { type: "task", id: selectedTaskId };
    if (selectedStepId) return { type: "step", id: selectedStepId };
    if (selectedWorkflowId) return { type: "workflow", id: selectedWorkflowId };
    return null;
  }

  const handleCloseTaskPanel = useCallback(() => {
    setSelectedTaskId(null);
    setPanelHistory([]);
  }, []);

  const handleDetachTaskPanel = useCallback(async () => {
    if (!selectedTaskId) return;
    await popOut(`/task/${selectedTaskId}`, `task-${selectedTaskId}`, {
      title: "Task Details",
      width: 720,
      height: 800,
    });
    setSelectedTaskId(null);
    setPanelHistory([]);
  }, [selectedTaskId]);

  const handleRelatedTaskSelect = useCallback(
    (taskId: string) => {
      const current = currentPanelEntry();
      if (current) setPanelHistory((prev) => [...prev, current]);
      setSelectedTaskId(taskId);
      setSelectedStepId(null);
      setSelectedWorkflowId(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedTaskId, selectedStepId, selectedWorkflowId]
  );

  const handleActiveRunTaskSelect = useCallback((taskId: string) => {
    setSelectedTaskId((currentTaskId) =>
      currentTaskId === taskId ? null : taskId
    );
    setSelectedStepId(null);
    setSelectedWorkflowId(null);
    setPanelHistory([]);
  }, []);

  const handleStepClick = useCallback((step: Step) => {
    setSelectedStepId(step.id || null);
    setSelectedTaskId(null);
    setSelectedWorkflowId(null);
    setPanelHistory([]);
  }, []);

  const handleWorkflowClick = useCallback((workflow: Workflow) => {
    setSelectedWorkflowId(workflow.id || null);
    setSelectedTaskId(null);
    setSelectedStepId(null);
    setPanelHistory([]);
  }, []);

  const handleCloseWorkflowPanel = useCallback(() => {
    setSelectedWorkflowId(null);
    setPanelHistory([]);
  }, []);

  const handleCloseStepPanel = useCallback(() => {
    setSelectedStepId(null);
    setPanelHistory([]);
  }, []);

  const handleWorkflowStepSelect = useCallback(
    (step: Step) => {
      if (selectedWorkflowId) {
        setPanelHistory((prev) => [
          ...prev,
          { type: "workflow", id: selectedWorkflowId },
        ]);
      }
      setSelectedStepId(step.id || null);
      setSelectedWorkflowId(null);
      setSelectedTaskId(null);
    },
    [selectedWorkflowId]
  );

  const handleBack = useCallback(() => {
    setPanelHistory((prev) => {
      const newHistory = [...prev];
      const entry = newHistory.pop();
      if (!entry) return prev;
      if (entry.type === "task") {
        setSelectedTaskId(entry.id);
        setSelectedStepId(null);
        setSelectedWorkflowId(null);
      } else if (entry.type === "step") {
        setSelectedStepId(entry.id);
        setSelectedTaskId(null);
        setSelectedWorkflowId(null);
      } else if (entry.type === "workflow") {
        setSelectedWorkflowId(entry.id);
        setSelectedTaskId(null);
        setSelectedStepId(null);
      }
      return newHistory;
    });
  }, []);

  useEffect(() => {
    const unlistenPromise = events.taskStepChangedEvent.listen((event) => {
      const { from_step_id, to_step_id, workflow_id } = event.payload;
      if (!from_step_id || !to_step_id) return;
      const fromLoc = stepLocationRef.current.get(from_step_id);
      const toLoc = stepLocationRef.current.get(to_step_id);
      if (
        !fromLoc ||
        !toLoc ||
        fromLoc.workflowId !== workflow_id ||
        toLoc.workflowId !== workflow_id
      )
        return;
      const edgeId = stepEdgeId(workflow_id, from_step_id, to_step_id);
      setFlashingEdgeIds((prev) => new Set(prev).add(edgeId));
      setTimeout(() => {
        setFlashingEdgeIds((prev) => {
          const next = new Set(prev);
          next.delete(edgeId);
          return next;
        });
      }, PIPELINE_FLASH_DURATION_MS);
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

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
        }, PIPELINE_FLASH_DURATION_MS);
      }
      if (stepId) {
        setFlashingStepIds((prev) => new Set(prev).add(stepId));
        setTimeout(() => {
          setFlashingStepIds((prev) => {
            const next = new Set(prev);
            next.delete(stepId);
            return next;
          });
        }, PIPELINE_FLASH_DURATION_MS);
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // ELK layout for workflow zones
  const workflowDimensions = useMemo(() => {
    const dimensions = new Map<string, { width: number; height: number }>();
    for (const wf of pipelineWorkflows) {
      const stepCount = wf.workflow_steps.length;
      dimensions.set(wf.id, {
        width: calculateWorkflowZoneWidth(stepCount),
        height: calculateWorkflowZoneHeight(),
      });
    }
    return dimensions;
  }, [pipelineWorkflows]);

  const elkLayoutNodes = useMemo((): LayoutNode[] => {
    return pipelineWorkflows.map((wf) => {
      const dims = workflowDimensions.get(wf.id) || {
        width: 800,
        height: 400,
      };
      return { id: wf.id, width: dims.width, height: dims.height };
    });
  }, [pipelineWorkflows, workflowDimensions]);

  const renderableWorkflowTransitions = useMemo(
    () => buildRenderableWorkflowTransitions(workflowTransitions),
    [workflowTransitions]
  );

  const elkLayoutEdges = useMemo((): LayoutEdge[] => {
    return renderableWorkflowTransitions.map(({ transition, elkEdgeId }) => ({
      id: elkEdgeId,
      source: transition.from_workflow_id,
      target: transition.to_workflow_id,
    }));
  }, [renderableWorkflowTransitions]);

  const { nodes: elkPositions, edges: elkEdgePaths } = useElkLayout(
    elkLayoutNodes,
    elkLayoutEdges,
    { direction: "DOWN", nodeSpacing: 60, layerSpacing: 120 }
  );

  // Build canvas nodes
  const allNodes = useMemo(() => {
    const nodes: Node[] = [];
    let fallbackY = 0;

    for (const wf of pipelineWorkflows) {
      const sortedSteps = workflowStepsMap.get(wf.id) ?? [];
      const taskCount = workflowTaskCounts.get(wf.id) ?? 0;
      const dimensions = workflowDimensions.get(wf.id) ?? {
        width: calculateWorkflowZoneWidth(sortedSteps.length),
        height: calculateWorkflowZoneHeight(),
      };
      const zoneWidth = dimensions.width;
      const zoneHeight = dimensions.height;

      const elkPosition = elkPositions.get(wf.id);
      const zoneX = elkPosition?.x ?? 0;
      const zoneY = elkPosition?.y ?? fallbackY;

      const workflowEntity = workflows.find((w) => w.id === wf.id);

      nodes.push({
        id: `workflow-zone-${wf.id}`,
        type: "workflowZoneNode",
        position: { x: zoneX, y: zoneY },
        width: zoneWidth,
        height: zoneHeight,
        data: {
          workflow: workflowEntity!,
          taskCount,
          stepCount: sortedSteps.length,
          width: zoneWidth,
          height: zoneHeight,
          onWorkflowClick: handleWorkflowClick,
          isWorkflowSelected: selectedWorkflow?.id === wf.id,
          isFlashing: flashingWorkflowIds.has(wf.id),
          isWorkflowHighlighted: highlightedTransitionWorkflowIds.has(wf.id),
        } as WorkflowZoneNodeData,
        draggable: false,
        selectable: false,
      });

      sortedSteps.forEach((step, index) => {
        const isStepSelected = selectedStepId === step.id;
        const aggregates = (step.id && stepAggregates.get(step.id)) || {
          taskCounts: { epic: 0, ticket: 0, task: 0 },
          active: 0,
        };

        nodes.push({
          id: `step-${wf.id}-${step.order ?? 0}`,
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
            taskCounts: aggregates.taskCounts,
            executionCounts: {
              active: aggregates.active,
              completed: 0,
              failed: 0,
            },
            isFlashing: step.id ? flashingStepIds.has(step.id) : false,
          } as StepNodeData,
          draggable: false,
        });
      });

      fallbackY += zoneHeight + LAYOUT_CONSTANTS.WORKFLOW_ZONE_GAP;
    }

    return nodes;
  }, [
    pipelineWorkflows,
    workflows,
    workflowStepsMap,
    workflowTaskCounts,
    stepAggregates,
    elkPositions,
    handleStepClick,
    selectedStepId,
    handleWorkflowClick,
    selectedWorkflow,
    flashingWorkflowIds,
    flashingStepIds,
    highlightedTransitionWorkflowIds,
    workflowDimensions,
  ]);

  const allEdges = useMemo(() => {
    const edges = buildStepTransitionEdges(
      pipelineWorkflows,
      flashingEdgeIds,
      selectedTransitionEdgeId
    );

    renderableWorkflowTransitions.forEach(({ transition, elkEdgeId }) => {
      const elkEdgePath = elkEdgePaths.get(elkEdgeId);

      const edgeId = `workflow-transition-${transition.from_workflow_id}-${transition.to_workflow_id}`;
      const isSelected = selectedTransitionEdgeId === edgeId;

      edges.push({
        id: edgeId,
        source: `workflow-zone-${transition.from_workflow_id}`,
        target: `workflow-zone-${transition.to_workflow_id}`,
        selected: isSelected,
        type: "elkRouted",
        animated: false,
        data: elkEdgePath
          ? ({
              sourcePoint: elkEdgePath.sourcePoint,
              targetPoint: elkEdgePath.targetPoint,
              bendPoints: elkEdgePath.bendPoints,
              label: transition.label,
              highlighted: isSelected,
            } as ElkRoutedEdgeData)
          : undefined,
        label: elkEdgePath ? undefined : transition.label,
        labelStyle: !elkEdgePath
          ? { fill: "#a1a1aa", fontSize: 11, fontWeight: 500 }
          : undefined,
        labelBgStyle: !elkEdgePath
          ? { fill: "#18181b", fillOpacity: 0.9 }
          : undefined,
        labelBgPadding: !elkEdgePath ? ([6, 3] as [number, number]) : undefined,
        labelBgBorderRadius: !elkEdgePath ? 4 : undefined,
        style: transitionEdgeStyle({ selected: isSelected, dashed: true }),
        markerEnd: transitionArrowMarker({ selected: isSelected }),
      });
    });

    return edges;
  }, [
    pipelineWorkflows,
    renderableWorkflowTransitions,
    elkEdgePaths,
    selectedTransitionEdgeId,
    flashingEdgeIds,
  ]);

  const [nodes, setNodes, onNodesChange] = useNodesState(allNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(allEdges);
  const hasFittedRef = useRef(false);

  useEffect(() => {
    setNodes(allNodes);
  }, [allNodes, setNodes]);

  useEffect(() => {
    if (!hasFittedRef.current && allNodes.length > 0) {
      hasFittedRef.current = true;
      requestAnimationFrame(() => {
        fitView({ padding: 0.1, minZoom: 0.3, maxZoom: 1.5 });
      });
    }
  }, [allNodes, fitView]);

  useEffect(() => {
    setEdges(allEdges);
  }, [allEdges, setEdges]);

  if (isLoading && pipelineWorkflows.length === 0) {
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

  if (error && pipelineWorkflows.length === 0) {
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

  if (pipelineWorkflows.length === 0) {
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
      <div className="relative flex-1 flex flex-col overflow-hidden">
        <div className="relative flex h-12 items-center border-b border-border bg-bg-primary px-6">
          <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />
          <div className="relative flex items-center gap-3">
            <h1 className="text-sm font-semibold text-text-primary">
              Workflow Pipelines
            </h1>
            <span className="font-mono text-xs text-text-muted">
              {pipelineWorkflows.length} workflow
              {pipelineWorkflows.length !== 1 ? "s" : ""} visualized
            </span>
          </div>
        </div>

        <div className="flex-1 relative">
          <TransitionEdgeMarkers />
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onEdgeClick={(_, edge) => {
              setSelectedTransitionEdgeId((prev) =>
                prev === edge.id ? null : edge.id
              );
            }}
            onPaneClick={() => setSelectedTransitionEdgeId(null)}
            onConnect={onConnect}
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
            <CanvasMiniMap className="!bottom-12 !right-4" />
          </ReactFlow>
          <ActiveRunsPanelContainer
            onTaskSelect={handleActiveRunTaskSelect}
            stepTypeById={stepTypeById}
          />
        </div>
      </div>

      <CreateTransitionModal
        pendingTransition={pendingTransition}
        fromWorkflowName={
          pendingTransition
            ? (workflows.find((w) => w.id === pendingTransition.from)?.name ??
              pendingTransition.from)
            : ""
        }
        toWorkflowName={
          pendingTransition
            ? (workflows.find((w) => w.id === pendingTransition.to)?.name ??
              pendingTransition.to)
            : ""
        }
        targetSteps={
          pendingTransition
            ? (workflowStepsMap.get(pendingTransition.to) ?? [])
            : []
        }
        label={pendingLabel}
        onLabelChange={setPendingLabel}
        targetStepId={pendingTargetStepId}
        onTargetStepChange={setPendingTargetStepId}
        isSubmitting={isCreatingTransition}
        error={createTransitionError}
        onCancel={() => setPendingTransition(null)}
        onConfirm={async () => {
          if (!pendingTransition) return;
          const ok = await handleCreateTransition(
            pendingTransition.from,
            pendingTransition.to,
            pendingLabel,
            pendingTargetStepId.length > 0 ? pendingTargetStepId : null
          );
          if (ok) setPendingTransition(null);
        }}
      />

      {selectedTaskId && (
        <TaskDetailPanel
          taskId={selectedTaskId}
          onClose={handleCloseTaskPanel}
          onTaskSelect={handleRelatedTaskSelect}
          onBack={panelHistory.length > 0 ? handleBack : undefined}
          onDetach={handleDetachTaskPanel}
        />
      )}

      {selectedStepId && (
        <StepDetailPanel
          stepId={selectedStepId}
          allSteps={allSteps}
          tasks={stepTasks}
          onTaskSelect={handleRelatedTaskSelect}
          selectedTaskId={selectedTaskId}
          onClose={handleCloseStepPanel}
          onDeleted={handleCloseStepPanel}
          onBack={panelHistory.length > 0 ? handleBack : undefined}
        />
      )}

      {selectedWorkflow && (
        <WorkflowDetailPanel
          workflow={selectedWorkflow}
          steps={workflowStepsMap.get(selectedWorkflow.id || "") || []}
          taskCount={workflowTaskCounts.get(selectedWorkflow.id || "") || 0}
          onClose={handleCloseWorkflowPanel}
          onStepSelect={handleWorkflowStepSelect}
          onBack={panelHistory.length > 0 ? handleBack : undefined}
        />
      )}
    </div>
  );
}

type ActiveRunsPanelProps = {
  items: ActiveTaskRun[];
  readyTasks: ActiveTaskRun["task"][];
  childTasksByParentId: Map<string, ActiveTaskRun["task"][]>;
  onTaskSelect: (taskId: string) => void;
  onRunSelect: (selection: SelectedTraceRun) => void;
  onTaskStart: (task: ActiveTaskRun["task"]) => void;
  onTaskStop: (task: ActiveTaskRun["task"]) => void;
  pendingTaskIds: Set<string>;
  stepTypeById: StepTypeById;
  activeTab: PipelinePanelTab;
  onTabChange: (tab: PipelinePanelTab) => void;
};

type SelectedTraceRun = {
  task: ActiveTaskRun["task"];
  taskRun: ActiveTaskRun["taskRun"];
};

function ActiveRunsPanelContainer({
  onTaskSelect,
  stepTypeById,
}: Pick<ActiveRunsPanelProps, "onTaskSelect" | "stepTypeById">) {
  useTasks(PIPELINE_TASK_FILTER);
  const [selectedTraceRun, setSelectedTraceRun] =
    useState<SelectedTraceRun | null>(null);
  const [activeTab, setActiveTab] = useState<PipelinePanelTab>("running");
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(
    () => new Set()
  );
  const items = useActivePipelineRuns();
  const readyTasks = useReadyPipelineTasks();
  const childTasksByParentId = useTasksByParentId();

  const handleRunSelect = useCallback((selection: SelectedTraceRun) => {
    setSelectedTraceRun((currentSelection) =>
      currentSelection?.taskRun.id === selection.taskRun.id ? null : selection
    );
  }, []);

  const setTaskPending = useCallback((taskId: string, pending: boolean) => {
    setPendingTaskIds((current) => {
      const next = new Set(current);
      if (pending) {
        next.add(taskId);
      } else {
        next.delete(taskId);
      }
      return next;
    });
  }, []);

  const handleTaskStart = useCallback(
    async (task: ActiveTaskRun["task"]) => {
      const runControls = deriveRunControlsState(task.run_controls ?? null, {
        hasWorkflow: Boolean(task.workflow_id),
      });
      if (runControls.runDisabled || pendingTaskIds.has(task.id)) return;
      setTaskPending(task.id, true);
      try {
        await commands.runWorkflow(task.id);
      } finally {
        setTaskPending(task.id, false);
      }
    },
    [pendingTaskIds, setTaskPending]
  );

  const handleTaskStop = useCallback(
    async (task: ActiveTaskRun["task"]) => {
      const runControls = deriveRunControlsState(task.run_controls ?? null, {
        hasWorkflow: Boolean(task.workflow_id),
      });
      if (runControls.stopDisabled || pendingTaskIds.has(task.id)) return;
      setTaskPending(task.id, true);
      try {
        await commands.stopRun({
          task_run_id: runControls.activeRun?.id ?? null,
          task_id: runControls.activeRun ? null : task.id,
        });
      } finally {
        setTaskPending(task.id, false);
      }
    },
    [pendingTaskIds, setTaskPending]
  );

  return (
    <div className="pointer-events-none absolute bottom-4 left-4 top-4 z-10 flex w-[32rem] max-w-[calc(100%-2rem)] flex-col gap-3">
      <ActiveRunsPanel
        items={items}
        readyTasks={readyTasks}
        childTasksByParentId={childTasksByParentId}
        onTaskSelect={onTaskSelect}
        onRunSelect={handleRunSelect}
        onTaskStart={handleTaskStart}
        onTaskStop={handleTaskStop}
        pendingTaskIds={pendingTaskIds}
        stepTypeById={stepTypeById}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
      {selectedTraceRun && (
        <ActiveRunTracePanel
          selection={selectedTraceRun}
          onClose={() => setSelectedTraceRun(null)}
        />
      )}
    </div>
  );
}

function RunStatusDot({
  task,
  status,
  stepTypeById,
}: {
  task: ActiveTaskRun["task"];
  status: TaskRunStatus;
  stepTypeById: StepTypeById;
}) {
  const indicator = runningIndicatorForTask(task, status, stepTypeById);
  return (
    <span
      className={`mx-0.5 inline-flex h-2 w-2 shrink-0 rounded-full ${indicator.dotClass} ${
        indicator.pulse ? "animate-pulse [animation-duration:3s]" : ""
      }`}
      title={indicator.label}
      aria-label={indicator.label}
      role="img"
    />
  );
}

function TraceIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 12h4l2-6 4 12 2-6h6"
      />
    </svg>
  );
}

function DetailsIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"
      />
    </svg>
  );
}

function StartIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M7 7h10v10H7z" />
    </svg>
  );
}

function IconButton({
  label,
  onClick,
  children,
  variant = "muted",
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  variant?: "muted" | "success" | "danger";
  disabled?: boolean;
}) {
  const variantClass =
    variant === "success"
      ? "text-success hover:bg-success/10 hover:text-success"
      : variant === "danger"
        ? "text-error hover:bg-error/10 hover:text-error"
        : "text-text-muted hover:bg-bg-secondary hover:text-text-primary";
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${variantClass}`}
    >
      {children}
    </button>
  );
}

function ActiveRunsPanel({
  items,
  readyTasks,
  childTasksByParentId,
  onTaskSelect,
  onRunSelect,
  onTaskStart,
  onTaskStop,
  pendingTaskIds,
  stepTypeById,
  activeTab,
  onTabChange,
}: ActiveRunsPanelProps) {
  if (items.length === 0 && readyTasks.length === 0) return null;
  const tabItems = activeTab === "running" ? items : readyTasks;

  return (
    <section
      aria-label="Pipeline task launcher"
      className="pointer-events-auto overflow-hidden rounded-lg border border-border bg-bg-elevated/95 shadow-xl backdrop-blur"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div
          role="tablist"
          aria-label="Pipeline task tabs"
          className="flex rounded-md bg-bg-primary p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "ready"}
            onClick={() => onTabChange("ready")}
            className={`rounded px-2 py-1 text-xs font-medium ${
              activeTab === "ready"
                ? "bg-bg-tertiary text-text-primary"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            Ready <Count value={readyTasks.length} />
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "running"}
            onClick={() => onTabChange("running")}
            className={`rounded px-2 py-1 text-xs font-medium ${
              activeTab === "running"
                ? "bg-bg-tertiary text-text-primary"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            Running <Count value={items.length} />
          </button>
        </div>
      </div>

      <div className="p-2">
        {activeTab === "ready" &&
          readyTasks.map((task) => (
            <TaskPanelRow
              key={task.id}
              task={task}
              onTaskSelect={onTaskSelect}
              onTaskStart={() => onTaskStart(task)}
              pending={pendingTaskIds.has(task.id)}
            />
          ))}
        {activeTab === "running" &&
          items.map(({ task, taskRun }) => {
            const childTasks = childTasksByParentId.get(task.id) ?? [];
            return (
              <div
                key={taskRun.id}
                className="border-l-2 border-l-success/50"
                data-testid="pipeline-active-run"
                data-run-status={taskRun.status}
              >
                <TaskPanelRow
                  task={task}
                  testId="pipeline-active-run-task-id"
                  onTaskSelect={onTaskSelect}
                  onTaskStop={() => onTaskStop(task)}
                  pending={pendingTaskIds.has(task.id)}
                  stepTypeById={stepTypeById}
                  onRunSelect={() => onRunSelect({ task, taskRun })}
                />
                {childTasks.length > 0 && (
                  <div
                    className="border-t border-border/60 bg-bg-primary/40 py-1 pl-5 pr-2"
                    data-testid="pipeline-active-run-children"
                  >
                    {childTasks.map((childTask) => (
                      <div
                        key={childTask.id}
                        className="flex w-full items-center gap-2 px-2 py-1 text-left"
                        data-testid="pipeline-active-run-child"
                      >
                        <div className="flex shrink-0 items-center gap-1">
                          {childTask.run_controls?.active_run && (
                            <IconButton
                              label={`Stop orchestration for ${childTask.title}`}
                              onClick={() => onTaskStop(childTask)}
                              variant="danger"
                              disabled={pendingTaskIds.has(childTask.id)}
                            >
                              <StopIcon />
                            </IconButton>
                          )}
                          {childTask.run_controls?.active_run && (
                            <RunStatusDot
                              task={childTask}
                              status={childTask.run_controls.active_run.status}
                              stepTypeById={stepTypeById}
                            />
                          )}
                          {childTask.run_controls?.active_run && (
                            <IconButton
                              label={`Show traces for ${childTask.title}`}
                              onClick={() =>
                                onRunSelect({
                                  task: childTask,
                                  taskRun: childTask.run_controls!.active_run!,
                                })
                              }
                            >
                              <TraceIcon />
                            </IconButton>
                          )}
                          <IconButton
                            label={`Show details for ${childTask.title}`}
                            onClick={() => onTaskSelect(childTask.id)}
                          >
                            <DetailsIcon />
                          </IconButton>
                        </div>
                        <IdentityBadge
                          id={childTask.id}
                          kind="task"
                          level={childTask.level}
                          className="shrink-0"
                          testId="pipeline-active-run-child-id"
                        />
                        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                          {childTask.title}
                        </span>
                        <span className="min-w-0 max-w-32 shrink truncate text-2xs text-text-muted">
                          {childTask.workflow_name ?? "No workflow"}{" "}
                          <span aria-hidden="true">&middot;</span>{" "}
                          {childTask.step_name ?? "No step"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        {tabItems.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-text-muted">
            No {activeTab} tasks.
          </div>
        )}
      </div>
    </section>
  );
}

function TaskPanelRow({
  task,
  testId = "pipeline-task-row-id",
  onTaskSelect,
  onRunSelect,
  onTaskStart,
  onTaskStop,
  stepTypeById = new Map(),
  pending = false,
}: {
  task: ActiveTaskRun["task"];
  testId?: string;
  onTaskSelect: (taskId: string) => void;
  onRunSelect?: () => void;
  onTaskStart?: () => void;
  onTaskStop?: () => void;
  stepTypeById?: StepTypeById;
  pending?: boolean;
}) {
  const workflowName = task.workflow_name ?? "No workflow";
  const stepName = task.step_name ?? "Unknown step";
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2 hover:bg-bg-secondary">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <div className="flex shrink-0 items-center gap-1">
          {onTaskStart && (
            <IconButton
              label={`Start orchestration for ${task.title}`}
              onClick={onTaskStart}
              variant="success"
              disabled={pending}
            >
              <StartIcon />
            </IconButton>
          )}
          {onTaskStop && (
            <IconButton
              label={`Stop orchestration for ${task.title}`}
              onClick={onTaskStop}
              variant="danger"
              disabled={pending}
            >
              <StopIcon />
            </IconButton>
          )}
          {onRunSelect && task.run_controls?.active_run && (
            <RunStatusDot
              task={task}
              status={task.run_controls.active_run.status}
              stepTypeById={stepTypeById}
            />
          )}
          {onRunSelect && (
            <IconButton
              label={`Show traces for ${task.title}`}
              onClick={onRunSelect}
            >
              <TraceIcon />
            </IconButton>
          )}
          <IconButton
            label={`Show details for ${task.title}`}
            onClick={() => onTaskSelect(task.id)}
          >
            <DetailsIcon />
          </IconButton>
        </div>
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-text-primary">
            <IdentityBadge
              id={task.id}
              kind="task"
              level={task.level}
              className="shrink-0"
              testId={testId}
            />
            <span className="truncate">{task.title}</span>
          </p>
          <p className="mt-1 truncate text-xs text-text-muted">
            {workflowName} <span aria-hidden="true">&middot;</span> {stepName}
          </p>
        </div>
      </div>
    </div>
  );
}

function groupSessionLogsByExecutionId(sessionLogs: readonly SessionLog[]) {
  const grouped: Record<string, SessionLog[]> = {};
  for (const log of sessionLogs) {
    const executionId = log.step_execution_id;
    if (!executionId) continue;
    grouped[executionId] = grouped[executionId] ?? [];
    grouped[executionId].push(log);
  }
  return grouped;
}

type ActiveRunTracePanelProps = {
  selection: SelectedTraceRun;
  onClose: () => void;
};

function ActiveRunTracePanel({ selection, onClose }: ActiveRunTracePanelProps) {
  const trace = useTaskRunTrace(selection.taskRun.id);
  const traceTasks = useMemo(() => [selection.task], [selection.task]);
  const runProjection = useMemo(
    () => projectTaskRunTrace(trace.taskRuns, trace.executions, traceTasks),
    [trace.executions, trace.taskRuns, traceTasks]
  );
  const groupedLogs = useMemo(
    () => groupSessionLogsByExecutionId(trace.sessionLogs),
    [trace.sessionLogs]
  );

  return (
    <section
      aria-label="Live task run trace"
      className="pointer-events-auto flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated/95 shadow-xl backdrop-blur"
      data-testid="pipeline-active-run-trace-panel"
      data-run-id={selection.taskRun.id}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-2 text-xs font-semibold uppercase text-text-secondary">
            Live trace
            <IdentityBadge
              id={selection.taskRun.id}
              kind="task run"
              className="shrink-0"
              testId="pipeline-active-run-trace-id"
            />
          </p>
          <p className="mt-1 truncate text-xs text-text-muted">
            {selection.task.title}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-text-muted hover:bg-bg-secondary hover:text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
          aria-label="Close live trace"
        >
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <UnifiedChatView
          rootTaskId={selection.task.id}
          executions={trace.executions}
          tasks={traceTasks}
          runProjection={runProjection}
          logsByExecutionId={groupedLogs}
          isLoading={trace.isLoading}
          error={trace.error}
          autoScroll
          activeExecutionId={selection.taskRun.latest_step_execution_id}
        />
      </div>
    </section>
  );
}

type CreateTransitionModalProps = {
  pendingTransition: { from: string; to: string } | null;
  fromWorkflowName: string;
  toWorkflowName: string;
  targetSteps: Step[];
  label: string;
  onLabelChange: (value: string) => void;
  targetStepId: string;
  onTargetStepChange: (value: string) => void;
  isSubmitting: boolean;
  error: string | undefined;
  onCancel: () => void;
  onConfirm: () => void;
};

function CreateTransitionModal({
  pendingTransition,
  fromWorkflowName,
  toWorkflowName,
  targetSteps,
  label,
  onLabelChange,
  targetStepId,
  onTargetStepChange,
  isSubmitting,
  error,
  onCancel,
  onConfirm,
}: CreateTransitionModalProps) {
  return (
    <FormModal
      isOpen={pendingTransition !== null}
      title="New workflow transition"
      onClose={onCancel}
      onSubmit={onConfirm}
      isSubmitting={isSubmitting}
      error={error}
      submitButtonText="Create transition"
    >
      <p className="mb-4 text-xs text-text-muted">
        From{" "}
        <span className="font-medium text-text-primary">
          {fromWorkflowName}
        </span>{" "}
        to{" "}
        <span className="font-medium text-text-primary">{toWorkflowName}</span>
      </p>

      <div>
        <label className="mb-1 block text-xs font-medium text-text-muted">
          Label (optional)
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          placeholder="e.g. needs review"
          autoFocus
          className="w-full rounded-md border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary outline-none focus:border-primary"
        />
      </div>

      <div className="mt-3">
        <label className="mb-1 block text-xs font-medium text-text-muted">
          Target step (optional)
        </label>
        <select
          value={targetStepId}
          onChange={(e) => onTargetStepChange(e.target.value)}
          className="w-full rounded-md border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary outline-none focus:border-primary"
        >
          <option value="">First step in target workflow</option>
          {targetSteps.map((step) => (
            <option key={step.id ?? step.name} value={step.id ?? ""}>
              {step.name}
            </option>
          ))}
        </select>
      </div>
    </FormModal>
  );
}

export function AllWorkflowsPipeline() {
  return (
    <ReactFlowProvider>
      <AllWorkflowsPipelineInner />
    </ReactFlowProvider>
  );
}
