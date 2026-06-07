/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — data bridge.

   buildAtlasModel(summary): PipelineSummary → AtlasModel (pure, geometry-free).
   This is the single source of truth for kind/role derivation, phase columns,
   and edge synthesis. It deliberately drops fake aggregates (runs24h / avg) and
   keeps only the real per-step/-workflow counts: `total` work items parked
   (epic + ticket + task) and `running` (those with an active TaskRun).
   ────────────────────────────────────────────────────────────────── */

import type {
  PipelineStep,
  PipelineSummary,
  PipelineWorkflow,
  StepType,
} from "../../../bindings";
import { hearthStepKind } from "../../WorkflowPipeline/stepTypeStyling";
import {
  type AtlasEdge,
  type AtlasModel,
  type AtlasPhase,
  type AtlasStep,
  type AtlasWorkflow,
  type Kind,
  type Role,
  UNPHASED,
} from "../layout/types";

/** Build the globally-unique step ref used as an edge endpoint. */
export function stepRef(workflowId: string, stepId: string): string {
  return `${workflowId}.${stepId}`;
}

/**
 * Derive the visual `Kind` of a step.
 *
 * Precedence (highest first): `final` → `entry` → type-mapped.
 *  - `final`  if `step.is_final`.
 *  Maps the REAL backend `StepType` via `hearthStepKind`, renaming the Hearth
 *  kinds to the Atlas vocabulary: `eval` (evaluate), `wait` (wait_children),
 *  `human` (human_input). `execute`/`route` pass through. `unknown` collapses to
 *  `execute` (a generic process box). There is no synthetic entry/final kind —
 *  the backend has no such types; position is `Role`, terminality is `is_final`.
 */
export function kindFor(step: Pick<PipelineStep, "step_type">): Kind {
  // PipelineStep.step_type is `string | null`. hearthStepKind only recognises
  // the known StepType strings (its lookup table throws on arbitrary values),
  // so gate on the known set and treat anything else as a generic process box.
  const known: ReadonlySet<string> = new Set([
    "execute",
    "evaluate",
    "route",
    "human_input",
    "wait_children",
  ]);
  const raw = step.step_type;
  if (raw === null || !known.has(raw)) return "execute";

  const hearth = hearthStepKind(raw as StepType);
  switch (hearth) {
    case "eval":
      return "eval";
    case "wait":
      return "wait";
    case "human":
      return "human";
    case "route":
      return "route";
    case "execute":
    case "unknown":
    default:
      return "execute";
  }
}

/** Derive the cosmetic foot `Role` of a step (flow position, not the type). */
export function roleFor(kind: Kind, isFirst: boolean, isFinal: boolean): Role {
  if (isFirst) return "entry";
  if (isFinal || kind === "route") return "exit";
  return "process";
}

/** Column label for a workflow (`kanban_column` or the `UNPHASED` bucket). */
function phaseOf(wf: PipelineWorkflow): string {
  const c = wf.kanban_column;
  return c === null || c.trim() === "" ? UNPHASED : c;
}

/**
 * Order phase columns by the minimum `display_order` among each column's
 * members, with the `UNPHASED` bucket always last. Ties broken by phase name
 * for determinism.
 */
function orderPhases(
  workflows: PipelineWorkflow[],
): { name: string; members: PipelineWorkflow[] }[] {
  const byPhase = new Map<string, PipelineWorkflow[]>();
  for (const wf of workflows) {
    const p = phaseOf(wf);
    const list = byPhase.get(p);
    if (list) list.push(wf);
    else byPhase.set(p, [wf]);
  }

  const cols = [...byPhase.entries()].map(([name, members]) => ({
    name,
    members: members
      .slice()
      .sort((a, b) => a.display_order - b.display_order),
    minOrder: Math.min(...members.map((w) => w.display_order)),
  }));

  cols.sort((a, b) => {
    const au = a.name === UNPHASED;
    const bu = b.name === UNPHASED;
    if (au !== bu) return au ? 1 : -1; // Unphased always last
    if (a.minOrder !== b.minOrder) return a.minOrder - b.minOrder;
    return a.name.localeCompare(b.name);
  });

  return cols.map(({ name, members }) => ({ name, members }));
}

/**
 * Resolve a cross-workflow transition's source step ref. There is no source
 * step on the backend payload, so we synthesise a plausible terminal step:
 * the last `route` step if one exists, else the last `final` step, else the
 * last step by order, else the initial step.
 */
function resolveSourceStep(wf: PipelineWorkflow): string | null {
  const steps = wf.workflow_steps;
  if (steps.length === 0) return wf.initial_step_id;

  const ordered = steps.slice().sort((a, b) => a.step_order - b.step_order);
  const lastRoute = [...ordered].reverse().find((s) => kindFor(s) === "route");
  if (lastRoute) return lastRoute.id;

  const lastFinal = [...ordered].reverse().find((s) => s.is_final);
  if (lastFinal) return lastFinal.id;

  return ordered[ordered.length - 1]?.id ?? wf.initial_step_id;
}

/**
 * Resolve a cross-workflow transition's target step ref. Prefer the declared
 * `target_step_id` (validated against the target workflow's steps), else the
 * target workflow's `initial_step_id`, else its first step.
 */
function resolveTargetStep(
  wf: PipelineWorkflow,
  targetStepId: string | null,
): string | null {
  const steps = wf.workflow_steps;
  if (
    targetStepId !== null &&
    steps.some((s) => s.id === targetStepId)
  ) {
    return targetStepId;
  }
  if (wf.initial_step_id !== null) return wf.initial_step_id;
  const ordered = steps.slice().sort((a, b) => a.step_order - b.step_order);
  return ordered[0]?.id ?? null;
}

/**
 * Pure transform: `PipelineSummary` → `AtlasModel`.
 *
 * Emits:
 *  - `workflows` with derived `phase` + task `total`/`running`.
 *  - `steps` with derived `kind`/`role`.
 *  - `edges`: intra-workflow `loop` edges (from `transitions_to` that point
 *    backward) and cross-workflow `handoff` edges (synthesised refs each end).
 *    Forward intra links are NOT emitted — `layoutFull` generates them from
 *    step order.
 *  - `phases`: ordered phase columns.
 */
export function buildAtlasModel(summary: PipelineSummary): AtlasModel {
  const wfById = new Map(summary.workflows.map((w) => [w.id, w]));

  const orderedPhases = orderPhases(summary.workflows);

  const phases: AtlasPhase[] = orderedPhases.map((p, index) => ({
    index,
    name: p.name,
    members: p.members.map((w) => w.id),
  }));

  const workflows: AtlasWorkflow[] = [];
  const steps: AtlasStep[] = [];
  const edges: AtlasEdge[] = [];

  for (const wf of summary.workflows) {
    const ordered = wf.workflow_steps
      .slice()
      .sort((a, b) => a.step_order - b.step_order);

    // ── step order index for loop detection (backward transition) ──
    const orderIndex = new Map(ordered.map((s, i) => [s.id, i]));

    let totalSum = 0;
    let runningSum = 0;
    ordered.forEach((s, i) => {
      const kind = kindFor(s);
      const role = roleFor(kind, i === 0, s.is_final);
      // "tasks parked here" = every work item across levels (epic + ticket +
      // task); "running" = how many of those have an active TaskRun.
      const c = s.pipeline_counts;
      const total = c.epic + c.ticket + c.task;
      const running = c.active;
      totalSum += total;
      runningSum += running;
      steps.push({
        id: stepRef(wf.id, s.id),
        stepId: s.id,
        workflowId: wf.id,
        name: s.name,
        kind,
        role,
        order: s.step_order,
        transitionsTo: s.transitions_to,
        isFinal: s.is_final,
        total,
        running,
      });

      // ── intra-workflow loop-backs ──
      // A transition into an earlier (or same) step in order is a loop; forward
      // transitions are implied by step order and synthesised in layoutFull.
      for (const targetId of s.transitions_to) {
        const fromIdx = i;
        const toIdx = orderIndex.get(targetId);
        if (toIdx === undefined) continue; // target outside this workflow
        if (toIdx > fromIdx) continue; // forward link — skip
        edges.push({
          id: `L_${wf.id}_${s.id}_${targetId}`,
          kind: "loop",
          from: stepRef(wf.id, s.id),
          to: stepRef(wf.id, targetId),
          fromWorkflow: wf.id,
          toWorkflow: wf.id,
          label: null,
        });
      }
    });

    workflows.push({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      initialStepId: wf.initial_step_id,
      phase: phaseOf(wf),
      displayOrder: wf.display_order,
      isDefault: wf.is_default,
      isFinal: wf.is_final,
      stepIds: ordered.map((s) => s.id),
      total: totalSum,
      running: runningSum,
    });
  }

  // ── cross-workflow handoffs ──
  for (const wf of summary.workflows) {
    for (const t of wf.transitions) {
      const target = wfById.get(t.to_workflow_id);
      if (!target) continue; // dangling target — drop

      const sourceStepId = resolveSourceStep(wf);
      const targetStepId = resolveTargetStep(target, t.target_step_id);
      if (sourceStepId === null || targetStepId === null) continue;

      edges.push({
        id: `X_${t.id}`,
        kind: "cross",
        from: stepRef(wf.id, sourceStepId),
        to: stepRef(target.id, targetStepId),
        fromWorkflow: wf.id,
        toWorkflow: target.id,
        label: t.label === "" ? null : t.label,
      });
    }
  }

  return { workflows, steps, edges, phases };
}
