/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — shared model + layout types.

   `buildAtlasModel(summary)` produces an `AtlasModel` (the pure, geometry-free
   description of the topology). The Map layout (`layoutCondensed`) consumes an
   `AtlasModel` and emits positioned geometry (`CondensedLayout`). The Graph
   uses the shared machine-flow adapter instead (adapter/buildMachineFlow.ts).
   ────────────────────────────────────────────────────────────────── */

import type { SessionDirective } from "../../../bindings";

/* ── kinds & roles ──────────────────────────────────────────────── */

/**
 * Visual step kind used across the Atlas — the REAL backend step type, mapped
 * from `StepType` via `hearthStepKind` (renaming `llm`/`wait`/`human`). Drives
 * `k-<kind>` token classes. NOTE: there is no synthetic `entry`/`final` kind —
 * the backend has no such step types; flow position is carried by `Role`, and
 * terminality by the finish type.
 */
export type Kind =
  | "llm"
  | "structured"
  | "execute"
  | "route"
  | "wait"
  | "human"
  | "finish"
  | "stop";

/** Cosmetic foot label on a step node — flow position, not the step type. */
export type Role = "entry" | "process" | "exit";

/** Edge category — intra-workflow forward/loop, or cross-workflow handoff. */
/**
 * `forward`: implied next-in-order link (never emitted by the adapter) ·
 * `branch`: a route step's transition that jumps past its next step ·
 * `loop`: a transition back to an earlier (or the same) step ·
 * `cross`: a workflow handoff.
 */
export type EdgeKind = "forward" | "branch" | "loop" | "cross";

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
  /** Session directives on those transitions, keyed by target step id. */
  transitionSessions: Partial<Record<string, SessionDirective>>;
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
  /** Optional factory name used to group related workflows. */
  factoryName: string | null;
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
 * NOT emitted by the adapter — they are implied by step order.
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
  /**
   * Route-decision labels for implied forward links, keyed
   * `"<fromRef>-><toRef>"` (loop and branch edges carry theirs on the edge).
   */
  forwardLabels?: Record<string, string>;
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
