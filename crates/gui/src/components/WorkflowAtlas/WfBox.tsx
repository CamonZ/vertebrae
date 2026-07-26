/**
 * One workflow container box on the Workflow Atlas canvas — the single travelling
 * element shared by both views.
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
import type { MouseEvent } from "react";
import { StepStrip } from "./StepStrip";
import { TaskCount } from "./TaskCount";
import { shortId } from "./layout/geometry";
import type { AtlasWorkflow, Kind, Rect } from "./layout/types";

export type WfBoxState = "" | "lit" | "dim";
export type WfBoxView = "graph" | "map";

export interface WfBoxProps {
  /** The workflow this box represents. */
  workflow: AtlasWorkflow;
  /** Absolute rect for the active view. */
  rect: Rect;
  /** Ordered step kinds (drives the map-face StepStrip). */
  shape: Kind[];
  /** Step count shown in the header/meta. */
  stepCount: number;
  /** Which face is active. */
  view?: WfBoxView;
  state?: WfBoxState;
  onHover?: (id: string | null) => void;
  onSelect?: (id: string) => void;
}

export function WfBox({
  workflow,
  rect,
  shape,
  stepCount,
  view = "graph",
  state = "",
  onHover,
  onSelect,
}: WfBoxProps) {
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
