/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — shared model + layout types.

   `buildAtlasModel(summary)` produces an `AtlasModel` (the pure, geometry-free
   description of the topology). The two layout ports — `layoutFull` (nested
   graph) and `layoutCondensed` (phase-column map) — consume an `AtlasModel`
   and emit positioned geometry (`FullLayout` / `CondensedLayout`).
   ────────────────────────────────────────────────────────────────── */

/* ── kinds & roles ──────────────────────────────────────────────── */

/**
 * Visual step kind used across the Atlas — the REAL backend step type, mapped
 * from `StepType` via `hearthStepKind` (renaming `eval`/`wait`/`human`). Drives
 * `k-<kind>` token classes. NOTE: there is no synthetic `entry`/`final` kind —
 * the backend has no such step types; flow position is carried by `Role`, and
 * terminality by the finish type.
 */
export type Kind =
  | "execute"
  | "eval"
  | "route"
  | "wait"
  | "human"
  | "finish";

/** Cosmetic foot label on a step node — flow position, not the step type. */
export type Role = "entry" | "process" | "exit";

/** Edge category — intra-workflow forward/loop, or cross-workflow handoff. */
export type EdgeKind = "forward" | "loop" | "cross";

/* ── model (geometry-free) ──────────────────────────────────────── */

/** A single workflow step in the topology model. */
export interface AtlasStep {
  /** Globally-unique step ref: `"<workflowId>.<stepId>"`. */
  id: string;
  /** Bare backend step id (unique only within its workflow). */
  stepId: string;
  workflowId: string;
  name: string;
  /** Raw backend step type, preserved for detail panels and test hooks. */
  stepType: string | null;
  kind: Kind;
  role: Role;
  /** Backend ordering within the workflow (ascending). */
  order: number;
  /** Bare backend step ids this step transitions into (same workflow). */
  transitionsTo: string[];
  /** All work items (epic + ticket + task) parked at this step. */
  total: number;
  /** How many of those have an active TaskRun. `running <= total`. */
  running: number;
}

/** A workflow container in the topology model. */
export interface AtlasWorkflow {
  id: string;
  name: string;
  description: string | null;
  /** Backend initial step id (bare), if any. */
  initialStepId: string | null;
  /** Phase / value-stream column this workflow belongs to. Never null — a
   *  missing `kanban_column` collapses to the `UNPHASED` bucket label. */
  phase: string;
  /** Backend display order (used for column ordering + intra-column stacking). */
  displayOrder: number;
  isDefault: boolean;
  /** Bare backend step ids belonging to this workflow, in order. */
  stepIds: string[];
  /** All work items parked across the workflow's steps (sum of step totals). */
  total: number;
  /** How many of those have an active TaskRun (sum of step running counts). */
  running: number;
}

/**
 * A directed edge in the topology model. Endpoints are `AtlasStep.id` refs
 * (`"<workflowId>.<stepId>"`). Forward intra-workflow links are intentionally
 * NOT emitted by the adapter — `layoutFull` synthesises them from step order.
 */
export interface AtlasEdge {
  id: string;
  kind: EdgeKind;
  /** Source step ref (`"<workflowId>.<stepId>"`). */
  from: string;
  /** Target step ref (`"<workflowId>.<stepId>"`). */
  to: string;
  /** Source workflow id (convenience; === `from`'s workflow). */
  fromWorkflow: string;
  /** Target workflow id (convenience; === `to`'s workflow). */
  toWorkflow: string;
  /** Trigger condition / transition label, if any. */
  label: string | null;
}

/** Ordered phase column metadata. */
export interface AtlasPhase {
  /** Column index (0-based, in display order). */
  index: number;
  /** Phase label (== `AtlasWorkflow.phase`). */
  name: string;
  /** Member workflow ids, in display order. */
  members: string[];
}

/** Pure output of `buildAtlasModel`. */
export interface AtlasModel {
  workflows: AtlasWorkflow[];
  steps: AtlasStep[];
  edges: AtlasEdge[];
  phases: AtlasPhase[];
}

/* ── positioned geometry (layout output) ────────────────────────── */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A laid-out point label (e.g. a transition condition chip). */
export interface LabelPos extends Point {
  text: string;
}

/** A positioned step node inside the full graph layout. */
export interface PlacedStep extends Rect {
  id: string;
  stepId: string;
  workflowId: string;
  name: string;
  kind: Kind;
  role: Role;
  /** 1-based ordinal shown on the node. */
  idx: number;
}

/** A positioned edge (after routing) ready to render. */
export interface PlacedEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  fromWorkflow: string;
  toWorkflow: string;
  label: string | null;
  points: Point[];
  labelPos: LabelPos | null;
  /** Hub-overlay cross edge (hidden at rest, shown only on trace). */
  hub?: boolean;
}

/** A positioned workflow container in the full graph layout. */
export interface PlacedWorkflow extends Rect {
  id: string;
  workflow: AtlasWorkflow;
  steps: PlacedStep[];
  /** Intra-workflow edges (forward + loop), positioned. */
  intra: PlacedEdge[];
}

/** Result of `layoutFull` — nested workflow⊃step graph with routed edges. */
export interface FullLayout {
  width: number;
  height: number;
  workflows: PlacedWorkflow[];
  /** Cross-workflow handoff edges (incl. hub overlays), positioned. */
  cross: PlacedEdge[];
  /** Ids of detected hub workflows. */
  hubIds: string[];
}

/** A positioned workflow card in the condensed map layout. */
export interface CondensedNode extends Rect {
  id: string;
  workflow: AtlasWorkflow;
  phase: string;
  col: number;
  cx: number;
  cy: number;
  left: number;
  right: number;
}

/** A positioned, aggregated workflow→workflow edge in the map layout. */
export interface CondensedEdge {
  id: string;
  from: string;
  to: string;
  /** Distinct trigger conditions aggregated across the underlying step edges. */
  labels: string[];
  points: Point[];
  labelPos: Point | null;
}

/** A positioned phase column header in the map layout. */
export interface CondensedColumn {
  index: number;
  x: number;
  cx: number;
  phase: string;
  members: string[];
  top: number;
}

/** Result of `layoutCondensed` — deterministic phase columns + orthogonal routing. */
export interface CondensedLayout {
  width: number;
  height: number;
  nodes: CondensedNode[];
  edges: CondensedEdge[];
  columns: CondensedColumn[];
}

/** Label used when a workflow has no `kanban_column`. */
export const UNPHASED = "Unphased";
