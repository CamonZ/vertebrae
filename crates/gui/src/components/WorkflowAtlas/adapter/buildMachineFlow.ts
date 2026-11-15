import type {
  JsonValue,
  PipelineSummary,
  PipelineWorkflow,
} from "../../../bindings";
import type {
  FlowSpec,
  PartSpec,
  RailSpec,
  RegionSpec,
} from "../../MachineDiagram/flow/spec";
import { decisionPort } from "../../MachineDiagram/flow/parts/topology";
import type { AtlasSelection } from "../inspector/selection";
import {
  routeDecisions,
  transitionSessionLabels,
  type SessionDirective,
} from "../inspector/routeSessions";
import { buildAtlasModel } from "./buildAtlasModel";

/** IDs contain no endpoint separator, even when backend IDs contain punctuation. */
export const machineId = (...keys: string[]): string =>
  "atlas_" +
  keys
    .map(
      (key) =>
        `${key.length}_${Array.from({ length: key.length }, (_, i) => key.charCodeAt(i).toString(16).padStart(4, "0")).join("")}`
    )
    .join("_");

export interface MachineTransition {
  readonly kind: "inferred" | "explicit" | "decision" | "handoff";
  readonly workflowId: string;
  /** Absent on workflow-level handoffs: the backend does not supply an origin step. */
  readonly stepId?: string;
  readonly targetWorkflowId: string;
  readonly targetStepId?: string;
  readonly decisionId?: string;
  /** Distinguishes a rule named default from the default decision. */
  readonly decisionKey?: string;
  readonly session?: SessionDirective | null;
  readonly transitionId?: string;
}

export interface AtlasMachineFlow {
  readonly spec: FlowSpec;
  /** Structural input identity, deliberately excluding counts and interaction state. */
  readonly structuralKey: string;
  readonly selections: ReadonlyMap<string, AtlasSelection>;
  readonly transitions: ReadonlyMap<string, MachineTransition>;
  readonly counts: ReadonlyMap<string, { total: number; running: number }>;
  readonly diagnostics: readonly string[];
}

const PART_KIND = {
  llm: "inference step",
  structured: "structured step",
  execute: "execute step",
  route: "route step",
  human: "human gate",
  wait: "wait children",
  stop: "run end",
  finish: "run end",
} as const;

/**
 * Additive bridge for an already scoped summary. No config fetching or routing.
 * Ordered adjacency remains an inferred link, even without a backend transition.
 * Explicit decisions replace that link to the same target, each on its own port.
 * Workflow handoffs originate at a neutral shared logical endpoint,
 * never at a guessed finish/route step. Empty workflows retain this endpoint.
 */
export function buildMachineFlow(
  summary: PipelineSummary,
  routeConfigs: ReadonlyMap<string, JsonValue | null> = new Map(),
  scope = ""
): AtlasMachineFlow {
  const model = buildAtlasModel(summary, routeConfigs);
  const parts: PartSpec[] = [];
  const rails: RailSpec[] = [];
  const regions: RegionSpec[] = [];
  const selections = new Map<string, AtlasSelection>();
  const transitions = new Map<string, MachineTransition>();
  const counts = new Map<string, { total: number; running: number }>();
  const diagnostics: string[] = [];
  const workflows = new Map(summary.workflows.map((wf) => [wf.id, wf]));
  const endpoint = (wf: string) => machineId("workflow", wf);
  const stepPart = (wf: string, step: string) => machineId("step", wf, step);

  function destination(wf: PipelineWorkflow, requested: string | null): string {
    if (requested && wf.workflow_steps.some((step) => step.id === requested))
      return requested;
    if (requested)
      diagnostics.push(
        `Workflow ${wf.id}: missing target ${requested}; using initial/first/logical endpoint`
      );
    if (
      wf.initial_step_id &&
      wf.workflow_steps.some((step) => step.id === wf.initial_step_id)
    )
      return wf.initial_step_id;
    if (wf.initial_step_id)
      diagnostics.push(
        `Workflow ${wf.id}: missing initial step ${wf.initial_step_id}`
      );
    return (
      wf.workflow_steps.slice().sort((a, b) => a.step_order - b.step_order)[0]
        ?.id ?? ""
    );
  }
  function target(wf: PipelineWorkflow, requested: string | null) {
    const step = destination(wf, requested);
    return { part: step ? stepPart(wf.id, step) : endpoint(wf.id), step };
  }
  function rail(
    id: string,
    from: string,
    to: string,
    metadata: MachineTransition,
    label?: string
  ) {
    rails.push({
      id,
      from,
      to,
      ...(label ? { label } : {}),
      conditional: metadata.kind === "decision",
    });
    transitions.set(id, metadata);
  }

  for (const wf of model.workflows) {
    const id = endpoint(wf.id);
    selections.set(id, { type: "workflow", workflowId: wf.id });
    selections.set(machineId("region", wf.id), {
      type: "workflow",
      workflowId: wf.id,
    });
    counts.set(id, { total: wf.total, running: wf.running });
    parts.push({
      id,
      kind: "topology endpoint",
      label: `${wf.name} · workflow endpoint`,
      job: "Logical workflow handoff endpoint; runtime source step unknown",
    });
    const members = [id];
    const steps = model.steps.filter((step) => step.workflowId === wf.id);
    for (const [index, step] of steps.entries()) {
      const partId = stepPart(wf.id, step.stepId);
      const selection: AtlasSelection = {
        type: "step",
        workflowId: wf.id,
        stepId: step.stepId,
      };
      selections.set(partId, selection);
      counts.set(partId, { total: step.total, running: step.running });
      members.push(partId);
      const next = steps[index + 1];
      const sessionLabels = transitionSessionLabels(
        step.transitionSessions,
        (id) => steps.find((s) => s.stepId === id)?.name ?? id
      );
      const config = routeConfigs.get(step.stepId);
      const decisions = step.kind === "route" ? routeDecisions(config) : [];
      if (step.kind === "route" && decisions.length === 0)
        diagnostics.push(
          `Route ${step.stepId}: unknown/empty config; only summary transitions and inferred order are shown`
        );
      if (
        !step.stepType ||
        ![
          "llm_inference",
          "structured_inference",
          "execute",
          "route",
          "human_input",
          "wait_children",
          "stop",
          "finish",
        ].includes(step.stepType)
      )
        diagnostics.push(
          `Step ${step.stepId}: unknown type ${step.stepType ?? "null"}; neutral process fallback`
        );
      // Duplicate rule IDs are malformed but must not collapse rails or ports.
      const frequencies = new Map<string, number>();
      for (const d of decisions.filter((d) => d.key !== "default"))
        frequencies.set(d.label, (frequencies.get(d.label) ?? 0) + 1);
      const usedNames = new Set<string>();
      const decisionNames = decisions.map((d) => {
        if (d.key === "default") return "default";
        let name =
          (frequencies.get(d.label) ?? 0) > 1
            ? `${d.label} [${d.key}]`
            : d.label;
        while (usedNames.has(name)) name += ` [${d.key}]`;
        usedNames.add(name);
        return name;
      });
      const names = decisionNames.filter(
        (_, i) => decisions[i].key !== "default"
      );
      if ([...frequencies.values()].some((n) => n > 1))
        diagnostics.push(
          `Route ${step.stepId}: duplicate decision IDs disambiguated by rule position`
        );
      // Reserve an injective namespace for synthetic ports without colliding with rule IDs.
      const syntheticName = (label: string) => {
        let name = label;
        while (names.includes(name)) name += " (inferred)";
        names.push(name);
        return name;
      };
      const linked = new Set<string>();
      for (const [i, d] of decisions.entries()) {
        const toWorkflow = d.targetWorkflowId
          ? workflows.get(d.targetWorkflowId)
          : workflows.get(wf.id);
        if (!toWorkflow || (!d.targetStepId && !d.targetWorkflowId)) {
          diagnostics.push(
            `Route ${step.stepId} decision ${d.label}: unresolved destination`
          );
          continue;
        }
        let to: { part: string; step: string };
        if (d.targetWorkflowId) to = target(toWorkflow, null);
        else if (toWorkflow.workflow_steps.some((s) => s.id === d.targetStepId))
          to = {
            part: stepPart(wf.id, d.targetStepId!),
            step: d.targetStepId!,
          };
        else {
          diagnostics.push(
            `Route ${step.stepId} decision ${d.label}: dangling step ${d.targetStepId}`
          );
          continue;
        }
        if (toWorkflow.id === wf.id) linked.add(to.step);
        rail(
          machineId(
            "decision",
            wf.id,
            step.stepId,
            d.key === "default" ? "default" : "rule",
            decisionNames[i]
          ),
          `${partId}.${d.key === "default" ? "default" : decisionPort(decisionNames[i])}`,
          `${to.part}.in`,
          {
            kind: "decision",
            workflowId: wf.id,
            stepId: step.stepId,
            targetWorkflowId: toWorkflow.id,
            ...(to.step ? { targetStepId: to.step } : {}),
            decisionId: d.label,
            decisionKey: d.key,
            session: d.session,
          },
          `${d.label} · ${d.session?.mode ?? "new"}${d.session?.stepId && d.session.stepId !== to.step ? ` · ${steps.find((s) => s.stepId === d.session?.stepId)?.name ?? d.session.stepId}` : ""}`
        );
      }
      // Keep declared transitions (including loops) and ordered adjacency distinct in metadata.
      const targets = new Set(step.transitionsTo);
      if (next) targets.add(next.stepId);
      const validTargets = [...targets].filter((targetId) => {
        if (linked.has(targetId)) return false;
        if (steps.some((s) => s.stepId === targetId)) return true;
        diagnostics.push(
          `Step ${step.stepId}: dangling transition ${targetId}`
        );
        return false;
      });
      let outgoing = partId;
      // A finish has no runtime output port. Preserve unusual ordered/explicit links
      // on a separately labelled logical endpoint instead of inventing one on finish.
      if (step.kind === "finish" && validTargets.length > 0) {
        outgoing = machineId("ordering", wf.id, step.stepId);
        members.push(outgoing);
        selections.set(outgoing, selection);
        parts.push({
          id: outgoing,
          kind: "topology endpoint",
          label: `${step.name} · logical ordering`,
          job: "Ordering/declared links only; finish has no runtime output",
        });
        diagnostics.push(
          `Finish ${step.stepId}: outgoing links use a logical ordering endpoint`
        );
      }
      for (const targetId of validTargets) {
        const explicit = step.transitionsTo.includes(targetId);
        const name =
          step.kind === "route"
            ? syntheticName(
                `${explicit ? "Transition" : "Inferred next"} → ${steps.find((s) => s.stepId === targetId)!.name}`
              )
            : "out";
        const label =
          step.kind === "route" ? undefined : sessionLabels.get(targetId);
        rail(
          machineId("transition", wf.id, step.stepId, targetId),
          `${outgoing}.${step.kind === "route" ? decisionPort(name) : "out"}`,
          `${stepPart(wf.id, targetId)}.in`,
          {
            kind: explicit ? "explicit" : "inferred",
            workflowId: wf.id,
            stepId: step.stepId,
            targetWorkflowId: wf.id,
            targetStepId: targetId,
          },
          label
        );
      }
      parts.push({
        id: partId,
        kind: PART_KIND[step.kind],
        label: step.name,
        props: {
          topology: true,
          ...(step.kind === "route"
            ? {
                decisions: names,
                defaultDecision: decisions.some((d) => d.key === "default"),
              }
            : {}),
          ...(step.kind === "stop" || step.kind === "finish"
            ? { form: step.kind }
            : {}),
        },
      });
    }
    regions.push({
      id: machineId("region", wf.id),
      label: wf.name,
      liveHeader: true,
      parts: members,
    });
  }
  for (const wf of summary.workflows) {
    for (const transition of wf.transitions) {
      const toWorkflow = workflows.get(transition.to_workflow_id);
      if (!toWorkflow) {
        diagnostics.push(
          `Handoff ${transition.id}: destination workflow outside scope or missing`
        );
        continue;
      }
      const to = target(toWorkflow, transition.target_step_id);
      rail(
        machineId("handoff", transition.id),
        `${endpoint(wf.id)}.out`,
        `${to.part}.in`,
        {
          kind: "handoff",
          workflowId: wf.id,
          targetWorkflowId: toWorkflow.id,
          ...(to.step ? { targetStepId: to.step } : {}),
          transitionId: transition.id,
        },
        transition.label
      );
    }
  }
  const spec: FlowSpec = { version: 1, parts, rails, regions };
  return {
    spec,
    structuralKey: JSON.stringify({ scope, spec }),
    selections,
    transitions,
    counts,
    diagnostics,
  };
}
