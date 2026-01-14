import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { StepNode, type StepNodeData, type ExecutingTask } from './StepNode';
import { TaskNode, type TaskNodeData } from './TaskNode';
import {
  calculateTaskLayout,
  getTaskNodePosition,
  getExecutingTaskPosition,
} from './layoutUtils';
import type { Workflow, TaskWithRelations } from '../../bindings';

/**
 * Props for WorkflowPipeline component
 */
interface WorkflowPipelineProps {
  workflow: Workflow;
  executionState?: Map<string, { currentStep: string | number; status: string; error?: string }>;
  tasksWithRelations?: TaskWithRelations[];
  onPlayClick?: (taskId: string) => void;
  isExecuting?: boolean;
}

/**
 * Node type mapping for React Flow
 */
const nodeTypes: NodeTypes = {
  stepNode: StepNode,
  taskNode: TaskNode,
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
  workflow,
  executionState,
  tasksWithRelations = [],
  onPlayClick,
  isExecuting,
}: WorkflowPipelineProps) {
  // Sort steps by order to ensure correct layout
  const sortedSteps = useMemo(
    () => [...workflow.steps].sort((a, b) => a.order - b.order),
    [workflow.steps]
  );

  // Build a map of step names to step index for easier lookup
  const stepNameToIndex = useMemo(
    () =>
      new Map(
        sortedSteps.map((step, index) => [
          step.name.toLowerCase(),
          index,
        ])
      ),
    [sortedSteps]
  );

  // Separate done/rejected tasks from others
  const { activeTasks, doneTasks } = useMemo(() => {
    const active = tasksWithRelations.filter(
      (tr) => tr.task.status !== 'done' && tr.task.status !== 'rejected'
    );
    const done = tasksWithRelations.filter(
      (tr) => tr.task.status === 'done' || tr.task.status === 'rejected'
    );
    return { activeTasks: active, doneTasks: done };
  }, [tasksWithRelations]);

  // Calculate task layout based on dependencies (only for active tasks)
  const taskLayout = useMemo(() => {
    if (activeTasks.length === 0) return new Map();

    return calculateTaskLayout(
      activeTasks.map((tr) => ({
        id: tr.task.id!,
        dependsOnIds: tr.depends_on_ids,
        dependentIds: tr.dependent_ids,
      }))
    );
  }, [activeTasks]);

  // Convert active tasks to React Flow nodes (left side - dependency graph)
  const taskNodes: Node<TaskNodeData>[] = useMemo(
    () =>
      activeTasks.map((tr) => {
        const layout = taskLayout.get(tr.task.id!);
        const executionStatus = executionState?.get(tr.task.id!);

        // Determine node status
        let status: 'waiting' | 'in_progress' | 'completed' | 'failed' = 'waiting';
        let error: string | undefined;

        if (executionStatus) {
          status = (executionStatus.status as 'waiting' | 'in_progress' | 'completed' | 'failed') || 'waiting';
          error = executionStatus.error;
        }

        // Calculate position
        let position = layout
          ? getTaskNodePosition(layout)
          : { x: -550, y: 0 };

        // If task is executing, animate towards the step it's in
        if (executionStatus && executionStatus.status === 'in_progress') {
          const stepIndex = typeof executionStatus.currentStep === 'number'
            ? executionStatus.currentStep
            : stepNameToIndex.get(
                (executionStatus.currentStep as string)?.toLowerCase() || ''
              ) ?? 0;

          if (layout) {
            position = getExecutingTaskPosition(
              stepIndex,
              0,
              NODE_Y_POSITION,
              layout.depth,
              sortedSteps.length
            );
          }
        }

        return {
          id: `task-${tr.task.id}`,
          type: 'taskNode',
          position,
          data: {
            task: tr.task,
            status: status as 'waiting' | 'in_progress' | 'completed' | 'failed',
            error,
            hasBlockers: tr.depends_on_ids.length > 0,
            isBlocking: tr.dependent_ids.length > 0,
          },
        };
      }),
    [
      activeTasks,
      taskLayout,
      executionState,
      sortedSteps.length,
      stepNameToIndex,
    ]
  );

  // Create done tasks stack nodes (right side, after last step)
  const doneTasksNodes: Node<TaskNodeData>[] = useMemo(() => {
    if (doneTasks.length === 0) return [];

    const doneX = (sortedSteps.length) * 320 + 200; // Position after last step

    return doneTasks.map((tr, index) => ({
      id: `done-task-${tr.task.id}`,
      type: 'taskNode',
      position: {
        x: doneX,
        y: 40 + index * 15, // Stack with slight offset
      },
      data: {
        task: tr.task,
        status: 'completed' as const,
        error: undefined,
        hasBlockers: false,
        isBlocking: false,
      },
    }));
  }, [doneTasks, sortedSteps.length]);

  // Convert workflow steps to React Flow nodes (right side)
  const stepNodes: Node<StepNodeData>[] = useMemo(
    () =>
      sortedSteps.map((step, index) => {
        // Find tasks for this step
        const stepTasks: ExecutingTask[] = [];
        if (executionState && activeTasks.length > 0) {
          for (const tr of activeTasks) {
            const state = executionState.get(tr.task.id!);
            if (state && state.status === 'in_progress') {
              // Handle both numeric step index and step name
              let taskStepIndex: number | undefined;
              if (typeof state.currentStep === 'number') {
                taskStepIndex = state.currentStep;
              } else if (typeof state.currentStep === 'string') {
                taskStepIndex = stepNameToIndex.get(state.currentStep.toLowerCase());
              }

              if (taskStepIndex === index) {
                stepTasks.push({
                  id: tr.task.id!,
                  title: tr.task.title,
                  status: (state.status as 'waiting' | 'in_progress' | 'completed' | 'failed') || 'waiting',
                  error: state.error,
                });
              }
            }
          }
        }

        return {
          id: `step-${step.order}`,
          type: 'stepNode',
          position: { x: index * NODE_SPACING_X, y: NODE_Y_POSITION },
          data: {
            step,
            isFirst: index === 0,
            isLast: index === sortedSteps.length - 1,
            tasks: stepTasks,
            onPlayClick,
            isExecuting,
          },
        };
      }),
    [
      sortedSteps,
      executionState,
      activeTasks,
      stepNameToIndex,
      onPlayClick,
      isExecuting,
    ]
  );

  // Combine all nodes (active tasks, steps, and done tasks)
  const allNodes = useMemo(
    () => [...taskNodes, ...stepNodes, ...doneTasksNodes],
    [taskNodes, stepNodes, doneTasksNodes]
  );

  // Create edges for task stack dependencies
  const dependencyEdges: Edge[] = useMemo(
    () => {
      const edges: Edge[] = [];
      const activeTaskIds = new Set(activeTasks.map((tr) => tr.task.id));
      const seenStackEdges = new Set<string>();

      activeTasks.forEach((tr) => {
        const layout = taskLayout.get(tr.task.id!);
        if (!layout) return;

        // Create edges from dependencies to this task (only if both are active)
        tr.depends_on_ids.forEach((depId) => {
          if (activeTaskIds.has(depId)) {
            const depLayout = taskLayout.get(depId);
            if (depLayout) {
              // Create stack-level edge if stacks are different
              const stackEdgeId = `stack-${depLayout.stackIndex}-${layout.stackIndex}`;
              if (depLayout.stackIndex !== layout.stackIndex && !seenStackEdges.has(stackEdgeId)) {
                seenStackEdges.add(stackEdgeId);

                // Use first task in each stack for edge routing
                edges.push({
                  id: stackEdgeId,
                  source: `task-${depId}`,
                  target: `task-${tr.task.id}`,
                  type: 'smoothstep',
                  style: {
                    strokeWidth: 2.5,
                    stroke: 'var(--color-warning)',
                    opacity: 0.8,
                  },
                });
              }
            }
          }
        });
      });

      return edges;
    },
    [activeTasks, taskLayout]
  );

  // Create edges connecting sequential steps (between step nodes)
  const stepEdges: Edge[] = useMemo(
    () =>
      sortedSteps.slice(0, -1).map((step, index) => ({
        id: `edge-${step.order}-${sortedSteps[index + 1].order}`,
        source: `step-${step.order}`,
        target: `step-${sortedSteps[index + 1].order}`,
        type: 'smoothstep',
        animated: true,
        style: {
          strokeWidth: 2,
          stroke: 'var(--color-primary)',
        },
      })),
    [sortedSteps]
  );

  // Combine all edges
  const allEdges = useMemo(() => [...dependencyEdges, ...stepEdges], [dependencyEdges, stepEdges]);

  const [nodes, , onNodesChange] = useNodesState(allNodes);
  const [edges, , onEdgesChange] = useEdgesState(allEdges);

  // Calculate initial viewport to fit all nodes
  const defaultViewport = useMemo(() => {
    const totalWidth = sortedSteps.length * NODE_SPACING_X;
    const zoom = totalWidth > 800 ? Math.max(0.5, 800 / totalWidth) : 0.8;
    return { x: -200, y: 40, zoom };
  }, [sortedSteps.length]);

  // Minimap node color
  const minimapNodeColor = useCallback(() => {
    return 'var(--color-primary)';
  }, []);

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
          <p className="mt-3 text-sm font-medium text-text-primary">No steps defined</p>
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
        defaultViewport={defaultViewport}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.25}
        maxZoom={2}
        colorMode="dark"
        attributionPosition="bottom-left"
        proOptions={{ hideAttribution: true }}
        style={{ backgroundColor: '#0c0c0e' }}
      >
        <Controls
          showInteractive={false}
          className="!rounded-lg !border-border !bg-bg-elevated !shadow-lg"
        />
        <MiniMap
          nodeColor={minimapNodeColor}
          maskColor="rgba(0, 0, 0, 0.6)"
          bgColor="#1f1f23"
          pannable
          zoomable
          className="!rounded-lg !border-border"
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
