/**
 * A small absolutely-positioned chip carrying a transition/condition label on
 * the Workflow Atlas MAP face: the trigger condition on a workflow→workflow
 * handoff (`.al-cond`). When the underlying aggregate edge carries several
 * conditions, the first is shown with a `+N` overflow badge.
 *
 * `state` mirrors the edge's trace state ('' rest · 'lit' on trace · 'dim'
 * faded). Render-only; positioned by its `left`/`top` (the layout's `labelPos`).
 *
 * Ported from docs/design/workflow-views.jsx (`.al-cond`).
 */
export type EdgeLabelState = "" | "lit" | "dim";

export interface EdgeLabelProps {
  /** Distinct labels carried by this edge; first is shown, rest become `+N`. */
  labels: string[];
  left: number;
  top: number;
  state?: EdgeLabelState;
}

export function EdgeLabel({ labels, left, top, state = "" }: EdgeLabelProps) {
  if (labels.length === 0) return null;
  const extra = labels.length - 1;
  const text = labels[0] + (extra > 0 ? ` +${extra}` : "");
  const cls = "al-cond" + (state ? " " + state : "");
  return (
    <div className={cls} style={{ left, top }}>
      {text}
    </div>
  );
}
