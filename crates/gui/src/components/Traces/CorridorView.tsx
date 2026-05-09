/**
 * CorridorView — CORRIDOR mode of /traces/:taskId.
 *
 * Renders a DAG canvas where:
 *   - nodes  = step executions (one column per task lane, time-ordered).
 *   - edges  = step transitions within a task.
 *   - branch = parent-task execution → first execution of a delegated child.
 *
 * Status-colored borders, pan / zoom, click-to-jump-THREAD with detail pin.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { StepExecution, Task } from "../../bindings";
import {
  computeCorridorLayout,
  computeCorridorLayoutFromProjection,
  type CorridorLayout,
  type CorridorNode,
  type CorridorNodeStatus,
} from "./corridor";
import type { TaskRunTraceProjection } from "./taskRunTrace";

interface CorridorViewProps {
  rootTaskId: string;
  executions: readonly StepExecution[];
  tasks: readonly Task[];
  runProjection?: TaskRunTraceProjection | null;
  /** Scroll container of the THREAD/UnifiedChatView; used to scroll-to-row. */
  threadScrollRef?: RefObject<HTMLElement | null>;
  /** Called when a node is clicked. Parent should pin detail in right pane. */
  onPinExecution?: (executionId: string) => void;
  /** Override layout (testing). */
  layout?: CorridorLayout;
}

const NODE_RADIUS = 22;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

function statusBorderClass(status: CorridorNodeStatus): string {
  switch (status) {
    case "failed":
      return "stroke-error";
    case "active":
      return "stroke-text-primary";
    default:
      return "stroke-border";
  }
}

function statusFillClass(status: CorridorNodeStatus): string {
  switch (status) {
    case "active":
      return "fill-bg-primary";
    case "failed":
      return "fill-bg-secondary";
    default:
      return "fill-bg-tertiary";
  }
}

export function CorridorView({
  rootTaskId,
  executions,
  tasks,
  runProjection,
  threadScrollRef,
  onPinExecution,
  layout: layoutOverride,
}: CorridorViewProps): ReactNode {
  const layout = useMemo(() => {
    if (layoutOverride) return layoutOverride;
    if (runProjection?.hasRuns) {
      return computeCorridorLayoutFromProjection(runProjection);
    }
    return computeCorridorLayout(rootTaskId, executions, tasks);
  }, [layoutOverride, rootTaskId, executions, tasks, runProjection]);

  const nodeById = useMemo(() => {
    const m = new Map<string, CorridorNode>();
    for (const n of layout.nodes) m.set(n.id, n);
    return m;
  }, [layout]);

  // viewport: pan (tx, ty) + zoom (scale). Applied as an SVG <g> transform.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const draggingRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);

  const handleWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>) => {
    // Pinch-to-zoom and Ctrl+wheel zoom; otherwise pan with wheel deltas.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.002);
      setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)));
      return;
    }
    setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
  }, []);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Only start drag-pan on background clicks (target === currentTarget or
      // the SVG itself); leave node clicks alone.
      const target = e.target as Element;
      if (target.closest('[data-testid="corridor-node"]')) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      draggingRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        panX: pan.x,
        panY: pan.y,
      };
    },
    [pan]
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = draggingRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      setPan({
        x: drag.panX + (e.clientX - drag.startX),
        y: drag.panY + (e.clientY - drag.startY),
      });
    },
    []
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = draggingRef.current;
      if (drag && drag.pointerId === e.pointerId) {
        draggingRef.current = null;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // capture may already be released
        }
      }
    },
    []
  );

  const handleNodeClick = useCallback(
    (node: CorridorNode) => {
      onPinExecution?.(node.executionId);
      const el = threadScrollRef?.current ?? null;
      if (!el) return;
      const target = el.querySelector<HTMLElement>(
        `[data-execution-id="${node.executionId}"]`
      );
      if (target?.scrollIntoView) {
        target.scrollIntoView({ behavior: "auto", block: "start" });
      }
    },
    [onPinExecution, threadScrollRef]
  );

  // Reset pan/zoom whenever the root task changes (new subtree).
  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setScale(1);
  }, [rootTaskId]);

  if (layout.nodes.length === 0) {
    return (
      <div
        data-testid="corridor-empty"
        className="flex h-full items-center justify-center text-xs text-text-muted"
      >
        No executions to graph yet.
      </div>
    );
  }

  return (
    <div
      data-testid="corridor-view"
      data-pan-x={pan.x.toFixed(2)}
      data-pan-y={pan.y.toFixed(2)}
      data-scale={scale.toFixed(3)}
      className="relative h-full w-full overflow-hidden bg-bg-secondary touch-none"
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      role="application"
      aria-label="Corridor DAG of subtree executions"
    >
      <svg
        data-testid="corridor-svg"
        className="h-full w-full cursor-grab"
        viewBox={`0 0 ${Math.max(layout.width, 1)} ${Math.max(layout.height, 1)}`}
        preserveAspectRatio="xMinYMin meet"
      >
        <g
          data-testid="corridor-transform"
          transform={`translate(${pan.x} ${pan.y}) scale(${scale})`}
        >
          {/* Lane labels */}
          {layout.lanes.map((lane) => (
            <text
              key={`lane-${lane.laneId}`}
              data-testid="corridor-lane-label"
              data-task-id={lane.taskId}
              data-task-run-id={lane.taskRunId ?? undefined}
              x={lane.x}
              y={16}
              textAnchor="middle"
              className="fill-text-muted font-mono text-[10px] uppercase tracking-wider"
            >
              {lane.title ?? lane.taskId.slice(0, 8)}
            </text>
          ))}

          {/* Edges (rendered before nodes so nodes draw on top). */}
          {layout.edges.map((edge) => {
            const from = nodeById.get(edge.fromNodeId);
            const to = nodeById.get(edge.toNodeId);
            if (!from || !to) return null;
            const isDelegation = edge.kind === "delegation";
            return (
              <line
                key={edge.id}
                data-testid={`corridor-edge-${edge.kind}`}
                data-from-execution-id={from.executionId}
                data-to-execution-id={to.executionId}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className={
                  isDelegation
                    ? "stroke-accent-primary"
                    : "stroke-text-muted"
                }
                strokeWidth={isDelegation ? 1.5 : 1}
                strokeOpacity={isDelegation ? 0.8 : 0.6}
                strokeDasharray={isDelegation ? "4 3" : undefined}
              />
            );
          })}

          {/* Nodes */}
          {layout.nodes.map((node) => (
            <g
              key={node.id}
              data-testid="corridor-node"
              data-execution-id={node.executionId}
              data-task-id={node.taskId}
              data-task-run-id={node.taskRunId ?? undefined}
              data-status={node.status}
              data-column={node.column}
              data-row={node.row}
              data-x={node.x}
              data-y={node.y}
              transform={`translate(${node.x} ${node.y})`}
              onClick={(e) => {
                e.stopPropagation();
                handleNodeClick(node);
              }}
              className="cursor-pointer"
            >
              <circle
                r={NODE_RADIUS}
                className={`${statusFillClass(node.status)} ${statusBorderClass(node.status)}`}
                strokeWidth={node.status === "failed" ? 2.5 : 1.5}
              />
              <text
                textAnchor="middle"
                y={4}
                className="pointer-events-none fill-text-primary font-mono text-[10px]"
              >
                {(node.stepName ?? "step").slice(0, 8)}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
