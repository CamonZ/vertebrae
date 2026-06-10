/**
 * One ELK-positioned step node on the Workflow Atlas / Graph canvas.
 *
 * "Geo" because the node is absolutely placed from a `PlacedStep` rect produced
 * by `layoutFull` (as opposed to the flowing strip segments on the map face).
 * Colour is driven entirely by the `k-<kind>` carrier class (the palette lives
 * in src/index.css) — this component never inlines a hue.
 *
 *   total/running: work items parked at this step, and how many are running —
 *                  surfaced as a TaskCount chip pair (replaces the old binary
 *                  run dot, which was meaningless on a busy system).
 *   state: '' resting · 'lit' on an active trace · 'dim' faded out of a trace.
 *   hovered: this exact node is under the cursor — emphasised over its lit
 *            siblings. Hovering a node also keeps its owning workflow traced
 *            (the nodes paint in a layer ABOVE the box, so without this the box
 *            would lose its own hover the moment the cursor crossed onto a step).
 *
 * Ported from docs/design/workflow-views.jsx (StepNode).
 */
import type { KeyboardEvent } from "react";
import { TaskCount } from "./TaskCount";
import type { PlacedStep } from "./layout/types";

export type StepNodeState = "" | "lit" | "dim";

export interface StepNodeGeoProps {
  step: PlacedStep;
  /** Work items parked at this step (epic + ticket + task). */
  total?: number;
  /** How many of those have an active TaskRun. */
  running?: number;
  state?: StepNodeState;
  /** This exact node is under the cursor — emphasised over lit siblings. */
  hovered?: boolean;
  /** Open this step in the inspector (workflowId, bare stepId). */
  onSelect?: (workflowId: string, stepId: string) => void;
  /** Cursor entered (the step) / left (null) — keeps the workflow traced. */
  onHover?: (step: PlacedStep | null) => void;
}

export function StepNodeGeo({
  step,
  total = 0,
  running = 0,
  state = "",
  hovered = false,
  onSelect,
  onHover,
}: StepNodeGeoProps) {
  const cls =
    "ag-step k-" +
    step.kind +
    (state ? " s-" + state : "") +
    (hovered ? " s-hover" : "");
  const select = () => onSelect?.(step.workflowId, step.stepId);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    select();
  };

  return (
    <div
      className={cls}
      data-testid={`step-node-${step.name}`}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={`Step ${step.name}`}
      style={{ left: step.x, top: step.y, width: step.w, height: step.h }}
      onMouseEnter={onHover ? () => onHover(step) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      onKeyDown={handleKeyDown}
      onClick={
        onSelect
          ? (e) => {
              e.stopPropagation();
              select();
            }
          : undefined
      }
    >
      <div className="ag-step-top">
        <span className="ag-step-num">{step.idx}</span>
        <span className="ag-step-name">{step.name}</span>
        <TaskCount total={total} running={running} className="uv-tc-step" />
      </div>
      <div className="ag-step-rule" />
      <div className="ag-step-foot">
        {step.role}
        <span className="ag-kind">{step.kind}</span>
      </div>
    </div>
  );
}
