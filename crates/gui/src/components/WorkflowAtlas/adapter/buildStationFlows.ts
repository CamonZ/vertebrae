/**
 * The two station levels of the Atlas Graph, as machine flows over the shared
 * parts: between factories (one `factory` station per factory, one rail per
 * directed factory route) and inside a factory (one `workflow` station per
 * workflow, one rail per pair of workflows that hand work to each other).
 * The steps level, inside one workflow, is `buildMachineFlow` with a context.
 *
 * No connection is dropped: a handoff either joins two stations of the level
 * or ends at a short labelled stub naming the factory it leaves for (or
 * arrives from). Stations and stubs open the next level down through
 * `destinations`; workflow stations also keep their inspector selection.
 * Live counts are presentation only and never enter the structural key.
 */
import type { PipelineSummary, PipelineWorkflow } from "../../../bindings";
import type {
  FlowSpec,
  PartSpec,
  RailSpec,
} from "../../MachineDiagram/flow/spec";
import { factoryPortFor } from "../../MachineDiagram/flow/parts/factory";
import { workflowPortFor } from "../../MachineDiagram/flow/parts/workflow";
import {
  FACTORY_MAX_STEPS,
  FACTORY_MAX_WORKFLOWS,
} from "../../MachineDiagram/parts/factorySpec";
import {
  WORKFLOW_MAX_STEPS,
  isWorkflowStepType,
} from "../../MachineDiagram/parts/workflowSpec";
import {
  matchesFactory,
  type FactoryFilterValue,
} from "../../../utils/workflowFactory";
import type { AtlasSelection } from "../inspector/selection";
import {
  buildFactoryOverviewGroups,
  factoryGroupKey,
  factoryRoutes,
  NO_FACTORY_KEY,
} from "../factoryOverviewModel";
import { buildAtlasModel } from "./buildAtlasModel";
import {
  machineId,
  hoverLabels,
  workflowFactoryScope,
  type AtlasLevelTarget,
  type AtlasMachineFlow,
  type MachineTransition,
} from "./buildMachineFlow";

type Count = { total: number; running: number };

const workflowCount = (wf: PipelineWorkflow): Count =>
  wf.workflow_steps.reduce(
    (acc, step) => ({
      total:
        acc.total +
        step.pipeline_counts.epic +
        step.pipeline_counts.ticket +
        step.pipeline_counts.task,
      running: acc.running + step.pipeline_counts.active,
    }),
    { total: 0, running: 0 }
  );

const sumCounts = (counts: readonly Count[]): Count => ({
  total: counts.reduce((n, c) => n + c.total, 0),
  running: counts.reduce((n, c) => n + c.running, 0),
});

/** Ordered workflows, as the factory and the Map order them. */
const ordered = (workflows: readonly PipelineWorkflow[]) =>
  workflows
    .slice()
    .sort(
      (a, b) =>
        a.display_order - b.display_order || a.name.localeCompare(b.name)
    );

/** Labels made unique with a positional suffix (port targets must be). */
function uniqueLabels(labels: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label} (${n})`;
  });
}

/**
 * Parts in flow order: a part comes after every part that hands to it,
 * otherwise in the given order; cycles keep the given order. The layout
 * reads spec order as model order and breaks cycles by it, so a source
 * listed after its target would be laid out as a return rail.
 */
export function flowOrder(
  parts: readonly PartSpec[],
  rails: readonly RailSpec[]
) {
  const index = new Map(parts.map((p, i) => [p.id, i]));
  const partOf = (end: string) => end.slice(0, end.lastIndexOf("."));
  const incoming = new Map(parts.map((p) => [p.id, new Set<string>()]));
  for (const r of rails) {
    const from = partOf(r.from);
    const to = partOf(r.to);
    if (from !== to && index.has(from)) incoming.get(to)?.add(from);
  }
  const placed = new Set<string>();
  const out: PartSpec[] = [];
  while (out.length < parts.length) {
    const ready =
      parts.find(
        (p) =>
          !placed.has(p.id) &&
          [...incoming.get(p.id)!].every((from) => placed.has(from))
      ) ?? parts.find((p) => !placed.has(p.id))!;
    placed.add(ready.id);
    out.push(ready);
  }
  return out;
}

function result(
  scope: string,
  spec: FlowSpec,
  parts: {
    selections: Map<string, AtlasSelection>;
    transitions: Map<string, MachineTransition>;
    counts: Map<string, Count>;
    testIds: Map<string, string>;
    diagnostics: string[];
    destinations: Map<string, AtlasLevelTarget>;
    names: Map<string, string>;
  }
): AtlasMachineFlow {
  const labelled = { ...spec, parts: spec.parts.map(hoverLabels) };
  return {
    spec: labelled,
    structuralKey: JSON.stringify({ scope, spec: labelled }),
    ...parts,
  };
}

/** The factory each workflow belongs to, by `factoryGroupKey`. */
const keyOf = (wf: { factory_name: string | null }) =>
  wf.factory_name ?? NO_FACTORY_KEY;

/**
 * Between factories: one factory station per factory and one rail per
 * directed factory route (the routes `factoryOverviewModel` counts), so each
 * factory's distinct neighbours match `factoryLinkCounts`.
 */
export function buildFactoryLevel(
  summary: PipelineSummary,
  scope = ""
): AtlasMachineFlow {
  const groups = buildFactoryOverviewGroups(summary);
  const routes = factoryRoutes(buildAtlasModel(summary));
  const byId = new Map(summary.workflows.map((wf) => [wf.id, wf]));
  const parts: PartSpec[] = [];
  const rails: RailSpec[] = [];
  const counts = new Map<string, Count>();
  const destinations = new Map<string, AtlasLevelTarget>();
  const names = new Map<string, string>();
  const testIds = new Map<string, string>();
  const transitions = new Map<string, MachineTransition>();
  const diagnostics: string[] = [];
  const partOf = (key: string) => machineId("factory", key);
  const nameOf = new Map(groups.map((g) => [factoryGroupKey(g), g.name]));
  const props = new Map<
    string,
    { workflows: number[]; inbound: string[]; outbound: string[] }
  >();
  for (const group of groups) {
    const key = factoryGroupKey(group);
    const workflows = ordered(
      group.workflowIds.map((id) => byId.get(id)!).filter(Boolean)
    );
    if (workflows.length > FACTORY_MAX_WORKFLOWS)
      diagnostics.push(
        `Factory ${group.name}: ${workflows.length} workflows; the station marks the first ${FACTORY_MAX_WORKFLOWS}`
      );
    const p = {
      workflows: workflows
        .slice(0, FACTORY_MAX_WORKFLOWS)
        .map((wf) =>
          Math.min(FACTORY_MAX_STEPS, Math.max(1, wf.workflow_steps.length))
        ),
      inbound: routes
        .filter((r) => r.to === key)
        .map((r) => nameOf.get(r.from) ?? r.from)
        .sort((a, b) => a.localeCompare(b)),
      outbound: routes
        .filter((r) => r.from === key)
        .map((r) => nameOf.get(r.to) ?? r.to)
        .sort((a, b) => a.localeCompare(b)),
    };
    props.set(key, p);
    const id = partOf(key);
    destinations.set(id, { level: "factory", scope: group.scope });
    names.set(id, group.name);
    testIds.set(id, `factory-station-${group.name}`);
    counts.set(id, sumCounts(workflows.map(workflowCount)));
    parts.push({
      id,
      kind: "factory",
      label: group.name,
      job: `${workflows.length} workflow${workflows.length === 1 ? "" : "s"}`,
      props: { ...p, topology: true },
    });
  }
  for (const route of routes) {
    const from = props.get(route.from);
    const to = props.get(route.to);
    if (!from || !to) continue;
    const fromName = nameOf.get(route.from) ?? route.from;
    const toName = nameOf.get(route.to) ?? route.to;
    const out = factoryPortFor(from, toName, "out");
    const inn = factoryPortFor(to, fromName, "in");
    if (!out || !inn) {
      diagnostics.push(`Factory route ${fromName} → ${toName}: no port`);
      continue;
    }
    const id = machineId("factory-route", route.from, route.to);
    rails.push({
      id,
      from: `${partOf(route.from)}.${out}`,
      to: `${partOf(route.to)}.${inn}`,
      ...(route.count > 1 ? { label: `${route.count} handoffs` } : {}),
    });
    // Station levels have no backend workflow for a factory; the rail keeps
    // its factory ends for TaskRun motion and the connections list.
    transitions.set(id, {
      kind: "handoff",
      workflowId: route.from,
      targetWorkflowId: route.to,
    });
  }
  return result(
    scope,
    { version: 1, parts: flowOrder(parts, rails), rails },
    {
      selections: new Map(),
      transitions,
      counts,
      testIds,
      diagnostics,
      destinations,
      names,
    }
  );
}

/**
 * Inside a factory: one workflow station per workflow of `factory` and one
 * rail per ordered pair of its workflows that hand work to each other.
 * Handoffs to (or from) workflows in another factory end at a stub naming
 * that factory, one stub per station and factory.
 */
export function buildWorkflowLevel(
  summary: PipelineSummary,
  factory: FactoryFilterValue,
  scope = ""
): AtlasMachineFlow {
  const all = new Map(summary.workflows.map((wf) => [wf.id, wf]));
  const inside = ordered(
    summary.workflows.filter((wf) => matchesFactory(wf.factory_name, factory))
  );
  const insideIds = new Set(inside.map((wf) => wf.id));
  const parts: PartSpec[] = [];
  const rails: RailSpec[] = [];
  const selections = new Map<string, AtlasSelection>();
  const transitions = new Map<string, MachineTransition>();
  const counts = new Map<string, Count>();
  const testIds = new Map<string, string>();
  const destinations = new Map<string, AtlasLevelTarget>();
  const names = new Map<string, string>();
  const diagnostics: string[] = [];
  const station = (wf: string) => machineId("station", wf);
  const factoryName = (wf: PipelineWorkflow) => wf.factory_name ?? "No Factory";
  const display = (wf: PipelineWorkflow) => wf.name || "Unnamed workflow";
  const unique = uniqueLabels(inside.map(display));
  const stationNames = new Map(inside.map((wf, i) => [wf.id, unique[i]]));

  /** One end of a handoff, as this level draws it. */
  type End =
    | { kind: "station"; workflow: PipelineWorkflow; label: string }
    | { kind: "stub"; workflow: PipelineWorkflow; label: string; key: string };
  const endOf = (wf: PipelineWorkflow): End =>
    insideIds.has(wf.id)
      ? { kind: "station", workflow: wf, label: stationNames.get(wf.id)! }
      : {
          kind: "stub",
          workflow: wf,
          label: factoryName(wf),
          key: keyOf(wf),
        };

  // Group backend handoffs into one rail per (source end, target end).
  interface Link {
    from: End;
    to: End;
    ids: string[];
    labels: string[];
  }
  const links = new Map<string, Link>();
  for (const wf of summary.workflows) {
    for (const t of wf.transitions) {
      const target = all.get(t.to_workflow_id);
      const fromInside = insideIds.has(wf.id);
      const toInside = !!target && insideIds.has(target.id);
      if (!fromInside && !toInside) continue;
      if (!target) {
        diagnostics.push(
          `Handoff ${t.id}: destination workflow ${t.to_workflow_id} missing`
        );
        continue;
      }
      const from = endOf(wf);
      const to = endOf(target);
      const key = JSON.stringify([
        from.kind === "station" ? from.workflow.id : `f:${from.label}`,
        to.kind === "station" ? to.workflow.id : `f:${to.label}`,
        // Stubs are per station: an outbound stub belongs to its source.
        from.kind === "stub" ? to.workflow.id : null,
        to.kind === "stub" ? from.workflow.id : null,
      ]);
      const link = links.get(key) ?? { from, to, ids: [], labels: [] };
      link.ids.push(t.id);
      if (t.label && !link.labels.includes(t.label)) link.labels.push(t.label);
      links.set(key, link);
    }
  }

  // Each station's outgoing transitions, labelled by where they lead.
  const outTargets = new Map<string, string[]>();
  for (const link of links.values()) {
    if (link.from.kind !== "station") continue;
    const list = outTargets.get(link.from.workflow.id) ?? [];
    if (!list.includes(link.to.label)) list.push(link.to.label);
    outTargets.set(link.from.workflow.id, list);
  }
  const stationProps = new Map<
    string,
    { steps: string[]; transitions: string[] }
  >();

  for (const wf of inside) {
    const id = station(wf.id);
    const name = stationNames.get(wf.id)!;
    selections.set(id, { type: "workflow", workflowId: wf.id });
    destinations.set(id, {
      level: "workflow",
      scope: workflowFactoryScope(wf),
      workflowId: wf.id,
    });
    names.set(id, name);
    testIds.set(id, `workflow-station-${name}`);
    counts.set(id, workflowCount(wf));
    const steps = wf.workflow_steps
      .slice()
      .sort((a, b) => a.step_order - b.step_order)
      .map((s) => {
        if (isWorkflowStepType(s.step_type)) return s.step_type;
        diagnostics.push(
          `Step ${s.id}: unknown type ${s.step_type ?? "null"}; drawn as execute`
        );
        return "execute";
      });
    if (steps.length > WORKFLOW_MAX_STEPS)
      diagnostics.push(
        `Workflow ${wf.id}: ${steps.length} steps; the station lamps the first ${WORKFLOW_MAX_STEPS}`
      );
    if (steps.length === 0) {
      // A workflow station draws at least one lamp; an empty workflow is a
      // labelled endpoint instead of an invented step.
      stationProps.set(wf.id, { steps: [], transitions: [] });
      parts.push({
        id,
        kind: "topology endpoint",
        label: `${name} · no steps`,
        job: "Workflow without steps",
      });
      continue;
    }
    const p = {
      steps: steps.slice(0, WORKFLOW_MAX_STEPS),
      transitions: outTargets.get(wf.id) ?? [],
    };
    stationProps.set(wf.id, p);
    parts.push({
      id,
      kind: "workflow",
      label: name,
      job: `${steps.length} step${steps.length === 1 ? "" : "s"}`,
      props: { ...p, topology: true },
    });
  }

  const stubIds = new Set<string>();
  const stubPart = (
    end: Extract<End, { kind: "stub" }>,
    anchor: string,
    direction: "out" | "in"
  ) => {
    const id = machineId("stub", direction, anchor, end.key);
    if (stubIds.has(id)) return id;
    stubIds.add(id);
    destinations.set(id, {
      level: "factory",
      scope: workflowFactoryScope(end.workflow),
    });
    names.set(id, end.label);
    testIds.set(id, `handoff-stub-${end.label}`);
    parts.push({
      id,
      kind: "topology endpoint",
      label: direction === "out" ? `→ ${end.label}` : `${end.label} →`,
      job:
        direction === "out"
          ? `Handoff to factory ${end.label}`
          : `Handoff from factory ${end.label}`,
      scale: 0.5,
    });
    return id;
  };

  for (const link of links.values()) {
    const { from, to } = link;
    let fromPort: string;
    let toPort: string;
    if (from.kind === "station") {
      const p = stationProps.get(from.workflow.id)!;
      const port = p.steps.length === 0 ? "out" : workflowPortFor(p, to.label);
      if (!port) {
        diagnostics.push(
          `Workflow ${from.workflow.id}: no port to ${to.label}`
        );
        continue;
      }
      fromPort = `${station(from.workflow.id)}.${port}`;
    } else fromPort = `${stubPart(from, to.workflow.id, "in")}.out`;
    if (to.kind === "station") toPort = `${station(to.workflow.id)}.in`;
    else toPort = `${stubPart(to, from.workflow.id, "out")}.in`;
    const id = machineId("link", fromPort, toPort);
    rails.push({
      id,
      from: fromPort,
      to: toPort,
      ...(link.labels.length
        ? {
            label:
              link.labels.length > 2
                ? `${link.labels.slice(0, 2).join(" · ")} +${link.labels.length - 2}`
                : link.labels.join(" · "),
          }
        : {}),
    });
    transitions.set(id, {
      kind: "handoff",
      workflowId: from.workflow.id,
      targetWorkflowId: to.workflow.id,
      transitionId: link.ids[0],
      transitionIds: link.ids,
    });
  }

  return result(
    scope,
    { version: 1, parts: flowOrder(parts, rails), rails },
    {
      selections,
      transitions,
      counts,
      testIds,
      diagnostics,
      destinations,
      names,
    }
  );
}
