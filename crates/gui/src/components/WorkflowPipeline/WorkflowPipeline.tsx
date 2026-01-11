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
const NODE_SPACING_X = 320;

/**
 * Vertical position for all nodes (single row layout)
 */
const NODE_Y_POSITION = 80;

/**
 * WorkflowPipeline displays workflow steps as a connected React Flow diagram.
 * Features neural-pathway-inspired design with signal flow animations.
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

  // Create edges connecting sequential steps with signal flow styling
  const initialEdges: Edge[] = useMemo(
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

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  // Calculate initial viewport to fit all nodes
  const defaultViewport = useMemo(() => {
    const totalWidth = sortedSteps.length * NODE_SPACING_X;
    const zoom = totalWidth > 800 ? Math.max(0.5, 800 / totalWidth) : 0.9;
    return { x: 40, y: 40, zoom };
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
    <div className="relative h-[500px] overflow-hidden rounded-xl border border-border bg-bg-secondary">
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
