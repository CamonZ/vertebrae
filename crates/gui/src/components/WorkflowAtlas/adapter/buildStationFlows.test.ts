import { describe, expect, it } from "vitest";
import type { PipelineSummary, PipelineWorkflow } from "../../../bindings";
import { compileFlow } from "../../MachineDiagram/flow/compile";
import { NO_FACTORY_SCOPE } from "../../../utils/workflowFactory";
import {
  buildFactoryOverviewGroups,
  factoryGroupKey,
  factoryLinkCounts,
  factoryRoutes,
} from "../factoryOverviewModel";
import { buildAtlasLevel } from "./atlasLevels";
import { buildAtlasModel } from "./buildAtlasModel";
import { machineId } from "./buildMachineFlow";
import { buildFactoryLevel, buildWorkflowLevel } from "./buildStationFlows";
import { step, workflow } from "./machineFlow.fixture";

const handoff = (id: string, from: string, to: string, label = id) => ({
  id,
  from_workflow_id: from,
  to_workflow_id: to,
  target_step_id: null,
  label,
});

const wf = (
  id: string,
  factory: string | null,
  transitions: PipelineWorkflow["transitions"] = []
): PipelineWorkflow => ({
  ...workflow(id, [
    step(`${id}-1`, "llm_inference", 0),
    step(`${id}-2`, "route", 1),
    step(`${id}-3`, "finish", 2),
  ]),
  factory_name: factory,
  transitions,
});

/**
 * Intake hands to Review twice (two workflows) and Review hands back once;
 * Review hands to Export; nothing hands to Archive; one workflow has no
 * factory and hands to Intake.
 */
const PROJECT: PipelineSummary = {
  workflows: [
    wf("intake", "Intake", [
      handoff("i-r", "intake", "review", "ready"),
      handoff("i-p", "intake", "polish"),
    ]),
    wf("polish", "Intake", [handoff("p-r", "polish", "review", "polished")]),
    wf("review", "Review", [
      handoff("r-i", "review", "intake", "rework"),
      handoff("r-e", "review", "export", "approved"),
      handoff("r-x", "review", "gone"),
    ]),
    wf("export", "Export"),
    wf("archive", "Archive"),
    wf("loose", null, [handoff("l-i", "loose", "intake", "classified")]),
  ],
};

const compiles = (spec: unknown) => {
  const result = compileFlow(spec);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.flow.arrangements[0];
};
const partOf = (end: string) => end.slice(0, end.lastIndexOf("."));

describe("between-factories level", () => {
  it("draws one factory station per factory and one rail per factory route, matching linkCounts", () => {
    const level = buildFactoryLevel(PROJECT);
    const groups = buildFactoryOverviewGroups(PROJECT);
    expect(level.spec.parts.map((p) => p.kind)).toEqual(
      groups.map(() => "factory")
    );
    expect(level.spec.parts.map((p) => p.label).sort()).toEqual(
      groups.map((g) => g.name).sort()
    );
    const routes = factoryRoutes(buildAtlasModel(PROJECT));
    expect(level.spec.rails ?? []).toHaveLength(routes.length);
    // Every factory's distinct neighbours over the rails = factoryLinkCounts.
    const neighbours = new Map<string, Set<string>>();
    const keyOf = new Map(
      groups.map((g) => [machineId("factory", factoryGroupKey(g)), g])
    );
    for (const r of level.spec.rails ?? []) {
      const a = factoryGroupKey(keyOf.get(partOf(r.from))!);
      const b = factoryGroupKey(keyOf.get(partOf(r.to))!);
      neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
      neighbours.set(b, (neighbours.get(b) ?? new Set()).add(a));
    }
    const counts = factoryLinkCounts(routes);
    for (const g of groups)
      expect(neighbours.get(factoryGroupKey(g))?.size ?? 0).toBe(
        counts.get(factoryGroupKey(g)) ?? 0
      );
    // Two Intake workflows hand to Review: one rail, labelled with the count.
    const intakeReview = level.spec.rails?.find(
      (r) => r.id === machineId("factory-route", "Intake", "Review")
    );
    expect(intakeReview?.label).toBe("2 handoffs");
    // Station levels pack and compile against the shared registry.
    expect(compiles(level.spec).parts).toHaveLength(groups.length);
  });

  it("opens each factory station on that factory's scope", () => {
    const level = buildFactoryLevel(PROJECT);
    expect(level.destinations?.get(machineId("factory", "Intake"))).toEqual({
      level: "factory",
      scope: "Intake",
    });
    expect(
      [...(level.destinations?.values() ?? [])].some(
        (t) => t.level === "factory" && t.scope === NO_FACTORY_SCOPE
      )
    ).toBe(true);
  });

  it("keeps live counts out of the structural key", () => {
    const busy = structuredClone(PROJECT);
    busy.workflows[0].workflow_steps[0].pipeline_counts.active = 7;
    busy.workflows[0].workflow_steps[0].pipeline_counts.ticket = 9;
    const a = buildFactoryLevel(PROJECT);
    const b = buildFactoryLevel(busy);
    expect(b.structuralKey).toBe(a.structuralKey);
    expect(b.counts.get(machineId("factory", "Intake"))).toEqual({
      total: 9,
      running: 7,
    });
  });
});

describe("inside-a-factory level", () => {
  it("draws every workflow as a station and ends cross-factory handoffs at stubs naming the factory", () => {
    const level = buildWorkflowLevel(PROJECT, "Intake");
    const d = compiles(level.spec);
    const stations = level.spec.parts.filter((p) => p.kind === "workflow");
    expect(stations.map((p) => p.label).sort()).toEqual(["intake", "polish"]);
    const stub = (direction: "in" | "out", inside: string, factory: string) =>
      machineId("stub", direction, inside, factory);
    // intake and polish both hand to Review: one stub per station.
    for (const id of [
      stub("out", "intake", "Review"),
      stub("out", "polish", "Review"),
      stub("in", "intake", "Review"),
      stub("in", "intake", "__no_factory__"),
    ])
      expect(d.parts.some((p) => p.id === id)).toBe(true);
    expect(
      level.spec.parts.find((p) => p.id === stub("out", "intake", "Review"))
        ?.label
    ).toBe("→ Review");
    expect(level.names?.get(stub("in", "intake", "__no_factory__"))).toBe(
      "No Factory"
    );
    // Stubs open the factory they name.
    expect(level.destinations?.get(stub("out", "intake", "Review"))).toEqual({
      level: "factory",
      scope: "Review",
    });
    expect(level.diagnostics.some((d) => d.includes("outside scope"))).toBe(
      false
    );
  });

  it("drops no handoff that touches the factory", () => {
    for (const factory of ["Intake", "Review", "Export", "Archive"]) {
      const level = buildWorkflowLevel(PROJECT, factory);
      const carried = new Set(
        [...level.transitions.values()].flatMap((t) => t.transitionIds ?? [])
      );
      const inside = new Set(
        PROJECT.workflows
          .filter((w) => w.factory_name === factory)
          .map((w) => w.id)
      );
      const known = new Set(PROJECT.workflows.map((w) => w.id));
      for (const w of PROJECT.workflows)
        for (const t of w.transitions) {
          const touches =
            inside.has(t.from_workflow_id) || inside.has(t.to_workflow_id);
          if (!touches) continue;
          if (known.has(t.to_workflow_id)) expect(carried.has(t.id)).toBe(true);
          // A handoff to a missing workflow is diagnosed, never silent.
          else
            expect(level.diagnostics.some((d) => d.includes(t.id))).toBe(true);
        }
      compiles(level.spec);
    }
  });

  it("opens a workflow station on its steps and keeps its inspector selection", () => {
    const level = buildWorkflowLevel(PROJECT, "Review");
    const id = machineId("station", "review");
    expect(level.selections.get(id)).toEqual({
      type: "workflow",
      workflowId: "review",
    });
    expect(level.destinations?.get(id)).toEqual({
      level: "workflow",
      scope: "Review",
      workflowId: "review",
    });
    // Workflow stations take step types, never step names.
    expect(level.spec.parts.find((p) => p.id === id)?.props?.steps).toEqual([
      "llm_inference",
      "route",
      "finish",
    ]);
  });
});

describe("inside-a-workflow level", () => {
  it("draws only that workflow's steps, with stubs naming the other workflows", () => {
    const level = buildAtlasLevel(PROJECT, new Map(), {
      kind: "steps",
      factory: "Review",
      workflowId: "review",
    });
    const d = compiles(level.spec);
    expect(d.regions.map((r) => r.label)).toEqual(["review"]);
    expect(
      level.spec.parts.filter(
        (p) => level.selections.get(p.id)?.type === "step"
      )
    ).toHaveLength(3);
    const toIntake = machineId("stub", "out", "review", "intake");
    const toExport = machineId("stub", "out", "review", "export");
    const fromIntake = machineId("stub", "in", "review", "intake");
    for (const id of [toIntake, toExport, fromIntake])
      expect(d.parts.some((p) => p.id === id)).toBe(true);
    expect(level.spec.parts.find((p) => p.id === toExport)?.label).toBe(
      "→ export"
    );
    // A stub opens the workflow it names, in that workflow's factory.
    expect(level.destinations?.get(toExport)).toEqual({
      level: "workflow",
      scope: "Export",
      workflowId: "export",
    });
    // Inbound stubs lead the spec so they lay out before their target.
    expect(level.spec.parts[0].id).toBe(fromIntake);
    // Only the handoff to a missing workflow is (diagnosed and) omitted.
    expect(
      level.diagnostics.filter((d) => d.includes("outside scope"))
    ).toEqual(["Handoff r-x: destination workflow outside scope or missing"]);
  });
});
