/**
 * One workflow or opaque factory container box on the Workflow Atlas canvas —
 * the single travelling element shared by both views.
 *
 * The box is absolutely placed from a `rect` and stacks two crossfading faces:
 *
 *   GRAPH face  — a header (name · status · short-id · N steps · description); the
 *                 ELK-positioned step nodes paint above it (in the step layer) so
 *                 they read as the box's contents.
 *   MAP face    — a condensed card: serif name, a `StepStrip` reduction of the
 *                 workflow's step kinds, and a `N steps` meta row.
 *
 * Which face shows is driven by `view`; the inactive face is hidden (`.hide`) so
 * P6's Map⇄Graph morph can crossfade them while the box travels between rects.
 *
 * Per the locked product decisions the header/meta show `N steps` plus the real
 * task counts: an always-on total badge (work items parked in the workflow) and
 * a running pill that only appears while some of them have an active TaskRun. The
 * fake `runs24h` / `avg` aggregates from the prototype are intentionally dropped.
 *
 * Ported from docs/design/workflow-views.jsx (WfBox).
 */
import type { KeyboardEvent, MouseEvent } from "react";
import { StepStrip } from "./StepStrip";
import { TaskCount } from "./TaskCount";
import { shortId } from "./layout/geometry";
import type { AtlasWorkflow, Kind, Rect } from "./layout/types";

export type WfBoxState = "" | "lit" | "dim";
export type WfBoxView = "graph" | "map";

interface WfBoxCommonProps {
  /** Absolute rect for the node. */
  rect: Rect;
  state?: WfBoxState;
  onHover?: (id: string | null) => void;
  onSelect?: (id: string) => void;
}

export interface WfBoxWorkflowProps extends WfBoxCommonProps {
  variant?: "workflow";
  /** The workflow this box represents. */
  workflow: AtlasWorkflow;
  /** Ordered step kinds (drives the map-face StepStrip). */
  shape: Kind[];
  /** Step count shown in the header/meta. */
  stepCount: number;
  /** Which face is active. */
  view?: WfBoxView;
}

export interface WfBoxFactoryProps extends WfBoxCommonProps {
  /** Opaque factory node shown at the unscoped overview level. */
  variant: "factory";
  factory: {
    id: string;
    name: string;
    workflowCount: number;
    workItemCount: number;
    activeCount: number;
  };
}

export type WfBoxProps = WfBoxWorkflowProps | WfBoxFactoryProps;

export function WfBox({
  rect,
  state = "",
  onHover,
  onSelect,
  ...node
}: WfBoxProps) {
  if (node.variant === "factory") {
    const factory = node.factory;
    const select = () => onSelect?.(factory.id);
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      select();
    };
    const cls = "uv-wf factory-node" + (state ? " " + state : "");
    return (
      <div
        className={cls}
        data-no-pan
        data-testid={`factory-node-${factory.name}`}
        role={onSelect ? "button" : undefined}
        tabIndex={onSelect ? 0 : undefined}
        aria-label={`Factory ${factory.name}`}
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        onKeyDown={onSelect ? handleKeyDown : undefined}
        onClick={onSelect ? select : undefined}
      >
        <div className="uv-factory-face">
          <span className="factory-overview-label">
            {factory.name === "No Factory" ? "Scope" : "Factory"}
          </span>
          <strong className="factory-overview-name">{factory.name}</strong>
          <span className="factory-overview-meta">
            {factory.workflowCount} workflow
            {factory.workflowCount === 1 ? "" : "s"}
            {factory.workItemCount > 0
              ? ` · ${factory.workItemCount} work item${factory.workItemCount === 1 ? "" : "s"}`
              : ""}
          </span>
          {factory.activeCount > 0 && (
            <span className="factory-overview-active">
              {factory.activeCount} active
            </span>
          )}
        </div>
      </div>
    );
  }

  const { workflow, shape, stepCount, view = "graph" } = node;
  const w = workflow;
  const cls = "uv-wf" + (state ? " " + state : "");
  const stepWord = stepCount === 1 ? "step" : "steps";
  const select = () => onSelect?.(w.id);
  const selectFromName = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    select();
  };

  return (
    <div
      className={cls}
      data-testid={`workflow-node-${w.name}`}
      aria-label={`Workflow ${w.name}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onMouseEnter={onHover ? () => onHover(w.id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      onClick={onSelect ? select : undefined}
    >
      {/* graph face */}
      <div
        className={"uv-face uv-face-graph" + (view === "graph" ? "" : " hide")}
      >
        <div className="ag-wf-hd">
          <div className="ag-wf-top">
            <button
              type="button"
              className="ag-wf-name"
              onClick={selectFromName}
            >
              {w.name}
            </button>
            {w.isDefault ? <span className="uv-default">default</span> : null}
            <TaskCount
              total={w.total}
              running={w.running}
              className="uv-tc-wf"
            />
          </div>
          <div className="ag-wf-meta">
            <span className="id">{shortId(w.id)}</span>
            <span className="sep">·</span>
            <span>
              {stepCount} {stepWord}
            </span>
          </div>
          {w.description ? (
            <div className="ag-wf-desc">{w.description}</div>
          ) : null}
        </div>
      </div>

      {/* map face */}
      <div className={"uv-face uv-face-map" + (view === "map" ? "" : " hide")}>
        <div className="al-card-hd">
          <button type="button" className="al-name" onClick={selectFromName}>
            {w.name}
          </button>
          {w.isDefault ? <span className="uv-default">default</span> : null}
          <TaskCount total={w.total} running={w.running} className="uv-tc-wf" />
        </div>
        <div className="al-steps">
          <StepStrip shape={shape} />
        </div>
        <div className="al-meta">
          <span>
            {stepCount} {stepWord}
          </span>
        </div>
      </div>
    </div>
  );
}
