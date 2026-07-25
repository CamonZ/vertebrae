/**
 * Step-kind legend footer for the Workflow Atlas canvas.
 *
 * Each swatch is driven by its `k-<kind>` carrier class (palette in
 * src/index.css). The legend covers the real backend step types only — there is
 * no synthetic entry/final kind. Render-only and stateless.
 *
 * Ported from docs/design/workflow-views.jsx (`.uv-legend`).
 */
import type { Kind } from "./layout/types";

const KINDS: ReadonlyArray<Kind> = [
  "execute",
  "eval",
  "route",
  "wait",
  "human",
  "finish",
];

export function KindLegend() {
  return (
    <footer className="uv-legend">
      {KINDS.map((k) => (
        <span key={k} className={"lg-item k-" + k}>
          <span className="sw" />
          {k}
        </span>
      ))}
    </footer>
  );
}
