import { useCallback, useEffect, useState } from "react";
import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";

/**
 * Node definition for ELK layout calculation
 */
export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

/**
 * Edge definition for ELK layout calculation
 */
export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * A point in 2D space for edge routing
 */
export interface LayoutPoint {
  x: number;
  y: number;
}

/**
 * Edge path calculated by ELK with bend points
 */
export interface LayoutEdgePath {
  id: string;
  source: string;
  target: string;
  /** Start point of the edge (on source node border) */
  sourcePoint?: LayoutPoint;
  /** End point of the edge (on target node border) */
  targetPoint?: LayoutPoint;
  /** Intermediate bend points for routing around nodes */
  bendPoints: LayoutPoint[];
}

/**
 * Result of ELK layout calculation
 */
export interface LayoutResult {
  nodes: Map<string, { x: number; y: number }>;
  /** Edge paths with bend points for proper routing */
  edges: Map<string, LayoutEdgePath>;
  isLayouting: boolean;
  error: string | null;
}

/**
 * ELK layout options
 */
export interface ElkLayoutOptions {
  direction?: "RIGHT" | "DOWN" | "LEFT" | "UP";
  nodeSpacing?: number;
  layerSpacing?: number;
  algorithm?: "layered" | "force" | "stress" | "mrtree";
}

const defaultOptions: ElkLayoutOptions = {
  direction: "RIGHT",
  nodeSpacing: 50,
  layerSpacing: 150,
  algorithm: "layered",
};

// Create a single ELK instance
const elk = new ELK();

/**
 * Hook to calculate ELK-based layout for workflow nodes.
 * Handles cycles/loops, orthogonal edge routing, and proper node positioning.
 *
 * @param nodes - Array of nodes with id, width, height
 * @param edges - Array of edges with id, source, target
 * @param options - Layout configuration options
 * @returns Layout result with node positions
 */
export function useElkLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: ElkLayoutOptions = {}
): LayoutResult {
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(
    new Map()
  );
  const [edgePaths, setEdgePaths] = useState<Map<string, LayoutEdgePath>>(
    new Map()
  );
  const [isLayouting, setIsLayouting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mergedOptions = { ...defaultOptions, ...options };

  const calculateLayout = useCallback(async () => {
    if (nodes.length === 0) {
      setPositions(new Map());
      setEdgePaths(new Map());
      return;
    }

    setIsLayouting(true);
    setError(null);

    try {
      // Build ELK graph structure
      const elkGraph: ElkNode = {
        id: "root",
        layoutOptions: {
          "elk.algorithm": mergedOptions.algorithm ?? "layered",
          "elk.direction": mergedOptions.direction ?? "RIGHT",
          // Spacing
          "elk.spacing.nodeNode": String(mergedOptions.nodeSpacing ?? 50),
          "elk.layered.spacing.nodeNodeBetweenLayers": String(mergedOptions.layerSpacing ?? 150),
          // Handle cycles/loops gracefully
          "elk.layered.cycleBreaking.strategy": "GREEDY",
          // Enable feedback edges (back-edges for loops)
          "elk.layered.feedbackEdges": "true",
          // Edge routing
          "elk.edgeRouting": "ORTHOGONAL",
          // Minimize edge crossings
          "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
          // Node placement strategy
          "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
          // Padding around the graph
          "elk.padding": "[top=20,left=20,bottom=20,right=20]",
        },
        children: nodes.map((node) => ({
          id: node.id,
          width: node.width,
          height: node.height,
        })),
        edges: edges.map((edge) => ({
          id: edge.id,
          sources: [edge.source],
          targets: [edge.target],
        })) as ElkExtendedEdge[],
      };

      // Run ELK layout algorithm
      const layoutedGraph = await elk.layout(elkGraph);

      // Extract positions from result
      const newPositions = new Map<string, { x: number; y: number }>();
      layoutedGraph.children?.forEach((child) => {
        if (child.x !== undefined && child.y !== undefined) {
          newPositions.set(child.id, { x: child.x, y: child.y });
        }
      });

      // Extract edge paths with bend points from result
      const newEdgePaths = new Map<string, LayoutEdgePath>();
      layoutedGraph.edges?.forEach((edge) => {
        const elkEdge = edge as ElkExtendedEdge;
        const source = elkEdge.sources?.[0] || "";
        const target = elkEdge.targets?.[0] || "";
        
        // ELK stores edge routing info in sections
        const sections = elkEdge.sections || [];
        const bendPoints: LayoutPoint[] = [];
        let sourcePoint: LayoutPoint | undefined;
        let targetPoint: LayoutPoint | undefined;

        if (sections.length > 0) {
          const section = sections[0];
          
          // Extract start point (on source node)
          if (section.startPoint) {
            sourcePoint = { x: section.startPoint.x, y: section.startPoint.y };
          }
          
          // Extract end point (on target node)
          if (section.endPoint) {
            targetPoint = { x: section.endPoint.x, y: section.endPoint.y };
          }
          
          // Extract bend points (intermediate routing points)
          if (section.bendPoints) {
            section.bendPoints.forEach((bp) => {
              bendPoints.push({ x: bp.x, y: bp.y });
            });
          }
        }

        newEdgePaths.set(elkEdge.id, {
          id: elkEdge.id,
          source,
          target,
          sourcePoint,
          targetPoint,
          bendPoints,
        });
      });

      setPositions(newPositions);
      setEdgePaths(newEdgePaths);
    } catch (err) {
      console.error("ELK layout error:", err);
      setError(String(err));
    } finally {
      setIsLayouting(false);
    }
  }, [
    nodes,
    edges,
    mergedOptions.algorithm,
    mergedOptions.direction,
    mergedOptions.nodeSpacing,
    mergedOptions.layerSpacing,
  ]);

  // Recalculate layout when inputs change
  useEffect(() => {
    calculateLayout();
  }, [calculateLayout]);

  return {
    nodes: positions,
    edges: edgePaths,
    isLayouting,
    error,
  };
}

/**
 * Synchronous function to calculate ELK layout (returns a promise).
 * Useful for one-time calculations outside of React hooks.
 */
export async function calculateElkLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: ElkLayoutOptions = {}
): Promise<Map<string, { x: number; y: number }>> {
  if (nodes.length === 0) {
    return new Map();
  }

  const mergedOptions = { ...defaultOptions, ...options };

  const elkGraph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": mergedOptions.algorithm ?? "layered",
      "elk.direction": mergedOptions.direction ?? "RIGHT",
      "elk.spacing.nodeNode": String(mergedOptions.nodeSpacing ?? 50),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(mergedOptions.layerSpacing ?? 150),
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.layered.feedbackEdges": "true",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.padding": "[top=20,left=20,bottom=20,right=20]",
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })) as ElkExtendedEdge[],
  };

  const layoutedGraph = await elk.layout(elkGraph);

  const positions = new Map<string, { x: number; y: number }>();
  layoutedGraph.children?.forEach((child) => {
    if (child.x !== undefined && child.y !== undefined) {
      positions.set(child.id, { x: child.x, y: child.y });
    }
  });

  return positions;
}
