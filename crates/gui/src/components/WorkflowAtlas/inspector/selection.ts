/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — inspector selection model + kind-class helper.

   `AtlasSelection` is the single selection state the canvas and the inspector
   share. Clicking a workflow box opens `{type:'workflow'}`; clicking a step node
   opens `{type:'step'}`. The inspector's clickable transitions emit new
   selections through `onSelect`, so the panel walks the topology in place.
   ────────────────────────────────────────────────────────────────── */
import type { Kind } from "../layout/types";

/** What the inspector is currently focused on. */
export type AtlasSelection =
  | { type: "workflow"; workflowId: string }
  | { type: "step"; workflowId: string; stepId: string };

/**
 * Map an Atlas `Kind` to its `k-<kind>` carrier class (the trio --kc/--kf/--kw
 * lives in src/index.css). `final` carries the terminal/ok hue under `k-final`.
 */
export function kindClass(kind: Kind): string {
  return "k-" + kind;
}
