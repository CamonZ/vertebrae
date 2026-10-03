/**
 * Role-shaped step nodes for the Workflow Atlas graph.
 *
 * The summary feed contains topology and parked/active work counts, but not
 * step configs or individual execution state. Each form therefore uses only
 * those facts: it does not invent model names, question counts, child progress,
 * or latest actions that the Atlas has not loaded.
 */
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { TaskCount } from "./TaskCount";
import { PrimitiveTypeIcon } from "./PrimitiveTypeIcon";
import type { Kind, PlacedStep } from "./layout/types";

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

const LABELS: Record<Kind, string> = {
  llm: "LLM inference",
  structured: "Structured inference",
  execute: "Execute",
  route: "Route",
  wait: "Wait for children",
  human: "Human input",
  stop: "Run boundary",
  finish: "Finish",
};

function WorkCount({ total, running }: { total: number; running: number }) {
  return <TaskCount total={total} running={running} className="uv-tc-step" />;
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="ag-step-eyebrow">{children}</span>;
}

function StepTitle({ children }: { children: ReactNode }) {
  return <span className="ag-step-title ag-step-name">{children}</span>;
}

function StructuredTypeKey() {
  return (
    <div className="ag-primitive-key" aria-label="Structured output types">
      <span className="ag-primitive-item">
        <PrimitiveTypeIcon type="choice" />
        Choice
      </span>
      <span className="ag-primitive-item">
        <PrimitiveTypeIcon type="score" />
        Score
      </span>
      <span className="ag-primitive-item">
        <PrimitiveTypeIcon type="noul" />
        Noul
      </span>
    </div>
  );
}

function NodeContent({
  kind,
  step,
  total,
  running,
}: {
  kind: Kind;
  step: PlacedStep;
  total: number;
  running: number;
}) {
  switch (kind) {
    case "llm":
      return (
        <>
          <div className="ag-step-card-body">
            <div className="ag-step-card-heading">
              <Eyebrow>LLM inference</Eyebrow>
              <WorkCount total={total} running={running} />
            </div>
            <StepTitle>{step.name}</StepTitle>
            <span className="ag-step-meta">Open-ended agent work</span>
          </div>
          <div className="ag-step-live-line">
            {running > 0 ? (
              <>
                <span className="ag-live-dot" aria-hidden="true" />
                <span>
                  {running} active run{running === 1 ? "" : "s"}
                </span>
              </>
            ) : total > 0 ? (
              <span>
                {total} work item{total === 1 ? "" : "s"} parked
              </span>
            ) : (
              <span>No active work</span>
            )}
          </div>
        </>
      );
    case "structured":
      return (
        <>
          <div className="ag-step-card-body">
            <div className="ag-step-card-heading">
              <Eyebrow>Structured inference</Eyebrow>
              <WorkCount total={total} running={running} />
            </div>
            <StepTitle>{step.name}</StepTitle>
            <span className="ag-step-meta">Typed questions</span>
          </div>
          <div className="ag-step-card-footer">
            <StructuredTypeKey />
          </div>
        </>
      );
    case "execute":
      return (
        <div className="ag-step-card-body ag-execute-body">
          <div className="ag-step-card-heading">
            <Eyebrow>Execute</Eyebrow>
            <WorkCount total={total} running={running} />
          </div>
          <StepTitle>{step.name}</StepTitle>
          <span className="ag-execute-rule" aria-hidden="true" />
          <span className="ag-step-meta">Deterministic script</span>
        </div>
      );
    case "route":
      return (
        <>
          <span className="ag-route-diamond" aria-hidden="true">
            <span>↗</span>
          </span>
          <span className="ag-route-label">
            <Eyebrow>Route</Eyebrow>
            <StepTitle>{step.goal?.trim() || step.name}</StepTitle>
          </span>
        </>
      );
    case "wait":
      return (
        <>
          <div className="ag-step-card-body">
            <div className="ag-step-card-heading">
              <Eyebrow>Wait for children</Eyebrow>
            </div>
            <StepTitle>{step.name}</StepTitle>
          </div>
          <div className="ag-step-card-footer ag-wait-counts">
            <span>Work items</span>
            <span>
              {total} parked · {running} active
            </span>
          </div>
        </>
      );
    case "human":
      return (
        <>
          <span className="ag-human-avatar" aria-hidden="true">
            ?
          </span>
          <span className="ag-human-copy">
            <Eyebrow>Human input</Eyebrow>
            <StepTitle>{step.name}</StepTitle>
            <span className="ag-step-meta">
              {running > 0 ? "Waiting for input" : "Requires a person"}
            </span>
          </span>
          <WorkCount total={total} running={running} />
        </>
      );
    case "stop":
      return (
        <span className="ag-stop-label">
          <span className="ag-stop-glyph" aria-hidden="true" />
          <span>Run boundary</span>
        </span>
      );
    case "finish":
      return (
        <>
          <span className="ag-finish-glyph" aria-hidden="true">
            <span />
          </span>
          <span>Finish</span>
          <span className="ag-sr-only">{step.name}</span>
        </>
      );
  }
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
  const kind = step.kind;
  const cls =
    "ag-step ag-step--" +
    kind +
    " k-" +
    kind +
    (state ? " s-" + state : "") +
    (hovered ? " s-hover" : "") +
    (step.futureRun ? " is-future-run" : "") +
    (kind === "human" && running > 0 ? " is-awaiting-input" : "") +
    (kind === "llm" && running > 0 ? " is-running" : "");
  const select = () => onSelect?.(step.workflowId, step.stepId);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    select();
  };
  const style: CSSProperties & {
    "--seam-offset"?: string;
    "--seam-extent"?: string;
  } = {
    left: step.x,
    top: step.y,
    width: step.w,
    height: step.h,
    "--seam-offset": `${step.seamOffset ?? 0}px`,
    "--seam-extent": `${step.seamExtent ?? 0}px`,
  };
  const accessibleDescription =
    running > 0
      ? `${LABELS[kind]}, ${running} active run${running === 1 ? "" : "s"}`
      : total > 0
        ? `${LABELS[kind]}, ${total} work item${total === 1 ? "" : "s"} parked`
        : LABELS[kind];
  return (
    <div
      className={cls}
      data-kind={kind}
      data-testid={`step-node-${step.name}`}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={`Step ${step.name}`}
      aria-description={accessibleDescription}
      style={style}
      onMouseEnter={onHover ? () => onHover(step) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      onKeyDown={handleKeyDown}
      onClick={
        onSelect
          ? (event) => {
              event.stopPropagation();
              select();
            }
          : undefined
      }
    >
      <NodeContent kind={kind} step={step} total={total} running={running} />
    </div>
  );
}
