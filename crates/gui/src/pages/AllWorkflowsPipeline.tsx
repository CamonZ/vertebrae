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
  type Connection,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  commands,
  events,
  type Step,
  type Workflow,
  type StepType,
  type AgentConfig,
  type WorkflowTransition,
} from "../bindings";
import {
  useElkLayout,
  type LayoutNode,
  type LayoutEdge,
  usePipelineSummary,
  useStepTasks,
} from "../hooks";
import type {
  PipelineStep,
  PipelineWorkflow,
} from "../hooks/usePipelineSummary";
import { useToastStore } from "../stores";
import { FormModal } from "../components/forms/FormModal";
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
} from "../components/WorkflowPipeline";
import { TaskDetailPanel } from "../components/TaskDetail";
import { StepDetailPanel } from "../components/StepDetail";
import { WorkflowDetailPanel } from "../components/WorkflowDetail";
import { popOut } from "../utils";

const nodeTypes: NodeTypes = {
  stepNode: StepNode,
  workflowZoneNode: WorkflowZoneNode,
};

const edgeTypes: EdgeTypes = {
  elkRouted: ElkRoutedEdge,
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

function AllWorkflowsPipelineInner() {
  const addToast = useToastStore((state) => state.addToast);
  const { fitView } = useReactFlow();

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
  const [pendingTransition, setPendingTransition] = useState<
    { from: string; to: string } | null
  >(null);
  const [pendingLabel, setPendingLabel] = useState("");
  const [pendingTargetStepId, setPendingTargetStepId] = useState<string>("");
  const [isCreatingTransition, setIsCreatingTransition] = useState(false);
  const [createTransitionError, setCreateTransitionError] = useState<string | undefined>(undefined);

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
        addToast("Cannot create a transition from a workflow to itself", "error");
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
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
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

  const elkLayoutEdges = useMemo((): LayoutEdge[] => {
    return workflowTransitions
      .filter((t) => t.from_workflow_id !== t.to_workflow_id)
      .map((t, index) => ({
        id: `elk-edge-${index}`,
        source: t.from_workflow_id,
        target: t.to_workflow_id,
      }));
  }, [workflowTransitions]);

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
    const edges: Edge[] = [];

    for (const wf of pipelineWorkflows) {
      const wfSteps = workflowStepsMap.get(wf.id) ?? [];
      const stepIdToOrder = new Map<string, number>();
      wfSteps.forEach((s) => {
        if (s.id) stepIdToOrder.set(s.id, s.order ?? 0);
      });
      wfSteps.forEach((s) => {
        if (!s.id) return;
        (s.transitions_to || []).forEach((targetStepId) => {
          const targetOrder = stepIdToOrder.get(targetStepId);
          if (targetOrder !== undefined) {
            edges.push({
              id: `edge-${wf.id}-${s.order}-${targetOrder}`,
              source: `step-${wf.id}-${s.order}`,
              target: `step-${wf.id}-${targetOrder}`,
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
    }

    workflowTransitions
      .filter((t) => t.from_workflow_id !== t.to_workflow_id)
      .forEach((transition, index) => {
        const elkEdgeId = `elk-edge-${index}`;
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
          labelBgPadding: !elkEdgePath
            ? ([6, 3] as [number, number])
            : undefined,
          labelBgBorderRadius: !elkEdgePath ? 4 : undefined,
          style: {
            stroke: isSelected ? "#f59e0b" : "rgba(251, 146, 60, 0.6)",
            strokeWidth: isSelected ? 2.5 : 2,
            strokeDasharray: "5,5",
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isSelected ? "#f59e0b" : "#a1a1a1",
            width: 18,
            height: 18,
          },
        });
      });

    return edges;
  }, [
    pipelineWorkflows,
    workflowStepsMap,
    workflowTransitions,
    elkEdgePaths,
    selectedTransitionEdgeId,
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
        <div className="relative border-b border-border bg-bg-primary px-6 py-4">
          <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />
          <div className="relative flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold text-text-primary">
                Workflow Pipelines
              </h1>
              <p className="mt-1 text-sm text-text-muted">
                {pipelineWorkflows.length} workflow
                {pipelineWorkflows.length !== 1 ? "s" : ""} visualized
              </p>
            </div>
          </div>
        </div>

        <div className="flex-1 relative">
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
          </ReactFlow>

          {selectedTransition && (
            <div className="absolute right-4 top-4 z-20 flex items-center gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2 shadow-lg">
              <div className="text-xs text-text-muted">
                <span className="font-medium text-text-primary">
                  {selectedTransition.from_workflow_name}
                </span>
                <span className="mx-1">to</span>
                <span className="font-medium text-text-primary">
                  {selectedTransition.to_workflow_name}
                </span>
                {selectedTransition.label && (
                  <span className="ml-2 italic">"{selectedTransition.label}"</span>
                )}
              </div>
              <button
                type="button"
                onClick={() =>
                  void handleDeleteTransition(
                    selectedTransition.from_workflow_id,
                    selectedTransition.to_workflow_id
                  )
                }
                className="rounded-md bg-error/15 px-2 py-1 text-xs font-medium text-error hover:bg-error/25"
                title="Delete transition (Delete or Backspace)"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      <CreateTransitionModal
        pendingTransition={pendingTransition}
        fromWorkflowName={
          pendingTransition
            ? workflows.find((w) => w.id === pendingTransition.from)?.name ?? pendingTransition.from
            : ""
        }
        toWorkflowName={
          pendingTransition
            ? workflows.find((w) => w.id === pendingTransition.to)?.name ?? pendingTransition.to
            : ""
        }
        targetSteps={
          pendingTransition ? workflowStepsMap.get(pendingTransition.to) ?? [] : []
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
        From <span className="font-medium text-text-primary">{fromWorkflowName}</span>{" "}
        to <span className="font-medium text-text-primary">{toWorkflowName}</span>
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
