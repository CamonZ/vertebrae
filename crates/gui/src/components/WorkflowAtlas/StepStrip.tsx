/**
 * Step-strip — the inline reduction of a workflow's step sequence shown on the
 * MAP face of a condensed workflow card. The full `shape` (an ordered list of
 * step `Kind`s) is rendered as a "ribbon": a flush bar of equal-flex coloured
 * segments, one per step — a compact "barcode" of the pipeline's kind mix.
 *
 * Colour is entirely class-driven off the `k-<kind>` token carrier (palette in
 * src/index.css) — this component never inlines a hue.
 *
 * Ported from docs/design/workflow-views.jsx (StepStrip, ribbon mode).
 */
import type { Kind } from "./layout/types";

export interface StepStripProps {
  /** The workflow's step kinds, in order. */
  shape: Kind[];
}

export function StepStrip({ shape }: StepStripProps) {
  return (
    <div className="al-ribbon" data-testid="step-strip-ribbon">
      {shape.map((k, i) => (
        <span key={i} className={"seg k-" + k} />
      ))}
    </div>
  );
}
