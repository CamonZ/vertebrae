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

import { StepNode, type StepNodeData } from './StepNode';
import type { Workflow } from '../../bindings';

/**
 * Props for WorkflowPipeline component
 */
interface WorkflowPipelineProps {
  workflow: Workflow;
}

/**
 * Node type mapping for React Flow
 */
const nodeTypes: NodeTypes = {
  stepNode: StepNode,
};

/**
 * Horizontal spacing between nodes
 */
const NODE_SPACING_X = 280;

/**
 * Vertical position for all nodes (single row layout)
 */
const NODE_Y_POSITION = 100;

/**
 * WorkflowPipeline displays workflow steps as a connected React Flow diagram.
 * Features:
 * - Custom StepNode for each workflow step
 * - Horizontal auto-layout
 * - Sequential edge connections
 * - Zoom, pan, and minimap controls
 */
export function WorkflowPipeline({ workflow }: WorkflowPipelineProps) {
  // Sort steps by order to ensure correct layout
  const sortedSteps = useMemo(
    () => [...workflow.steps].sort((a, b) => a.order - b.order),
    [workflow.steps]
  );

  // Convert workflow steps to React Flow nodes
  const initialNodes: Node<StepNodeData>[] = useMemo(
    () =>
      sortedSteps.map((step, index) => ({
        id: `step-${step.order}`,
        type: 'stepNode',
        position: { x: index * NODE_SPACING_X, y: NODE_Y_POSITION },
        data: {
          step,
          isFirst: index === 0,
          isLast: index === sortedSteps.length - 1,
        },
      })),
    [sortedSteps]
  );

  // Create edges connecting sequential steps
  const initialEdges: Edge[] = useMemo(
    () =>
      sortedSteps.slice(0, -1).map((step, index) => ({
        id: `edge-${step.order}-${sortedSteps[index + 1].order}`,
        source: `step-${step.order}`,
        target: `step-${sortedSteps[index + 1].order}`,
        type: 'smoothstep',
        animated: true,
        style: { strokeWidth: 2 },
      })),
    [sortedSteps]
  );

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  // Calculate initial viewport to fit all nodes
  const defaultViewport = useMemo(() => {
    const totalWidth = sortedSteps.length * NODE_SPACING_X;
    // Zoom out if there are many steps
    const zoom = totalWidth > 800 ? Math.max(0.5, 800 / totalWidth) : 1;
    return { x: 50, y: 50, zoom };
  }, [sortedSteps.length]);

  // Minimap node color based on position
  const minimapNodeColor = useCallback(() => {
    return 'var(--color-primary)';
  }, []);

  if (sortedSteps.length === 0) {
    return (
      <div className="flex h-[400px] items-center justify-center rounded-lg border border-border bg-bg-secondary">
        <p className="text-text-muted">No steps defined in this workflow</p>
      </div>
    );
  }

  return (
    <div className="h-[500px] rounded-lg border border-border bg-bg-secondary">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        defaultViewport={defaultViewport}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.25}
        maxZoom={2}
        attributionPosition="bottom-left"
      >
        <Controls
          className="!border-border !bg-bg-primary !shadow-md [&>button]:!border-border [&>button]:!bg-bg-primary [&>button]:!fill-text-secondary hover:[&>button]:!bg-bg-secondary"
          showInteractive={false}
        />
        <MiniMap
          className="!border-border !bg-bg-primary"
          nodeColor={minimapNodeColor}
          maskColor="rgba(0, 0, 0, 0.1)"
          pannable
          zoomable
        />
        <Background
          variant={BackgroundVariant.Dots}
          gap={16}
          size={1}
          className="!bg-bg-secondary"
        />
      </ReactFlow>
    </div>
  );
}
