/**
 * One Map workflow card or opaque factory node on the Workflow Atlas canvas.
 *
 * The box is absolutely placed from a `rect`. A workflow card shows a serif
 * name, a `StepStrip` reduction of the workflow's step kinds, and a `N steps`
 * meta row. The Graph view draws workflows with the shared machine scene.
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
import type { AtlasWorkflow, Kind, Rect } from "./layout/types";

export type WfBoxState = "" | "lit" | "dim";

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
  /** Step count shown in the meta row. */
  stepCount: number;
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
    const workflows = `${factory.workflowCount} workflow${factory.workflowCount === 1 ? "" : "s"}`;
    const items =
      factory.workItemCount > 0
        ? ` · ${factory.workItemCount} item${factory.workItemCount === 1 ? "" : "s"}`
        : "";
    const active =
      factory.activeCount > 0 ? ` · ${factory.activeCount} active` : "";
    return (
      <div
        className={cls}
        data-no-pan
        data-testid={`factory-node-${factory.name}`}
        role={onSelect ? "button" : undefined}
        tabIndex={onSelect ? 0 : undefined}
        aria-label={`Factory ${factory.name}`}
        aria-description={`${workflows}${items}${active}`}
        title={`${factory.name}\n${workflows}${items}${active}`}
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        onKeyDown={onSelect ? handleKeyDown : undefined}
        onClick={onSelect ? select : undefined}
        onMouseEnter={onHover ? () => onHover(factory.id) : undefined}
        onMouseLeave={onHover ? () => onHover(null) : undefined}
        onFocus={onHover ? () => onHover(factory.id) : undefined}
        onBlur={onHover ? () => onHover(null) : undefined}
      >
        <div className="uv-factory-face">
          {factory.activeCount > 0 ? (
            <i className="factory-marker-live" aria-hidden="true" />
          ) : null}
          <strong className="factory-overview-name">{factory.name}</strong>
          <span className="factory-overview-meta">{factory.workflowCount}</span>
        </div>
      </div>
    );
  }

  const { workflow, shape, stepCount } = node;
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
      <div className="uv-face uv-face-map">
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
