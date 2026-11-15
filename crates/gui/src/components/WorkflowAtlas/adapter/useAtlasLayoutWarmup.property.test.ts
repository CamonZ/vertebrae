/**
 * Property test of the Atlas layout warm-up (useAtlasLayoutWarmup.ts). The
 * warm-up only helps if it lays out exactly what the Graph will ask for.
 * Hegel generates projects — workflows spread over named factories and no
 * factory, with steps, transitions, handoffs (inside and across factories)
 * and arbitrary live counts — and for every scope the Atlas can open:
 *
 * - the warm-up visits it: every factory, the No Factory scope when some
 *   workflow has none, and the whole project, each once;
 * - the flow it warms has the same layout identity (the cache key the
 *   layout engine uses, per region and composed) as the flow the Graph lays
 *   out for that scope, whatever the live counts, and whether or not the
 *   Graph's input went through its structural-key round trip;
 * - live counts never change a scope's layout identity.
 */
import { test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { PipelineSummary, PipelineWorkflow } from "../../../bindings";
import { compileFlow } from "../../MachineDiagram/flow/compile";
import { levelKey, needsAutoLayout } from "../../MachineDiagram/flow/layout";
import type { FlowSpec } from "../../MachineDiagram/flow/spec";
import {
  NO_FACTORY_SCOPE,
  filterByFactory,
  type FactoryFilterValue,
} from "../../../utils/workflowFactory";
import { buildMachineFlow } from "./buildMachineFlow";
import { step, workflow } from "./machineFlow.fixture";
import {
  atlasTopology,
  atlasWarmupFlow,
  atlasWarmupScopes,
} from "./useAtlasLayoutWarmup";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const TYPES = [
  "llm_inference",
  "structured_inference",
  "execute",
  "route",
  "human_input",
  "wait_children",
  "stop",
  "finish",
] as const;

const count = gs.integers({ minValue: 0, maxValue: 40 });

const project = gs.composite<PipelineSummary>((tc) => {
  const n = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
  const factories = tc.draw(
    gs.arrays(gs.sampledFrom(["Intake", "Review", "Export"]), {
      minSize: n,
      maxSize: n,
    })
  );
  const workflows: PipelineWorkflow[] = factories.map((factory, w) => {
    const size = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
    const steps = Array.from({ length: size }, (_, i) => ({
      ...step(`w${w}s${i}`, tc.draw(gs.sampledFrom(TYPES)), i),
      task_counts: { epic: 0, ticket: tc.draw(count), task: tc.draw(count) },
      pipeline_counts: {
        epic: 0,
        ticket: tc.draw(count),
        task: 0,
        active: tc.draw(count),
      },
      active_count: tc.draw(count),
    }));
    steps.forEach((s, i) => {
      if (i + 1 < size) s.transitions_to = [steps[i + 1].id];
    });
    return {
      ...workflow(`w${w}`, steps),
      factory_name: tc.draw(gs.booleans()) ? factory : null,
    };
  });
  for (let h = tc.draw(gs.integers({ minValue: 0, maxValue: 5 })); h > 0; h--) {
    const from = tc.draw(gs.integers({ minValue: 0, maxValue: n - 1 }));
    const to = tc.draw(gs.integers({ minValue: 0, maxValue: n - 1 }));
    if (from === to) continue;
    workflows[from].transitions.push({
      id: `h${h}`,
      from_workflow_id: workflows[from].id,
      to_workflow_id: workflows[to].id,
      target_step_id: null,
      label: tc.draw(gs.sampledFrom(["ready", "repair", "intake-planning"])),
    });
  }
  return { workflows };
});

/** Layout identity of a spec: the key of every level the engine caches. */
function identity(spec: FlowSpec): string | null {
  const compiled = compileFlow(spec);
  if (!compiled.ok || !needsAutoLayout(compiled.flow)) return null;
  return levelKey(compiled.flow.arrangements);
}

/** What the Graph lays out for a scope (WorkflowAtlas → useAtlasMachineFlow). */
function graphIdentity(
  summary: PipelineSummary,
  scope: FactoryFilterValue
): string | null {
  const scoped =
    scope === null
      ? summary
      : { ...summary, workflows: filterByFactory(summary.workflows, scope) };
  const adapted = buildMachineFlow(
    scoped,
    new Map(),
    JSON.stringify([0, scope])
  );
  const { spec } = JSON.parse(adapted.structuralKey) as { spec: FlowSpec };
  return identity(spec);
}

const recount = (summary: PipelineSummary, k: number): PipelineSummary => ({
  workflows: summary.workflows.map((w) => ({
    ...w,
    workflow_steps: w.workflow_steps.map((s) => ({
      ...s,
      active_count: s.active_count + k,
      task_counts: { ...s.task_counts, ticket: s.task_counts.ticket + k },
      pipeline_counts: {
        ...s.pipeline_counts,
        active: s.pipeline_counts.active + k,
      },
    })),
  })),
});

test("the warm-up lays out exactly what each scope's Graph will ask for", () =>
  hegel.test(
    (tc) => {
      const summary = tc.draw(project);
      const scopes = atlasWarmupScopes(summary);
      const named = new Set(
        summary.workflows.map((w) => w.factory_name).filter((f) => f !== null)
      );
      check(
        scopes.length === new Set(scopes.map((s) => JSON.stringify(s))).size,
        "a scope is warmed twice"
      );
      for (const f of named)
        check(scopes.includes(f), `factory ${f} is never warmed`);
      check(scopes.includes(null), "the whole project is never warmed");
      check(
        scopes.includes(NO_FACTORY_SCOPE) ===
          summary.workflows.some((w) => w.factory_name === null),
        "the No Factory scope is warmed exactly when it exists"
      );
      const k = tc.draw(gs.integers({ minValue: 1, maxValue: 9 }));
      for (const scope of scopes) {
        // The hook warms the count-free topology, not the live summary.
        const warm = atlasWarmupFlow(atlasTopology(summary), new Map(), scope);
        const warmKey = warm ? levelKey(warm.arrangements) : null;
        const shown = graphIdentity(summary, scope);
        check(
          warmKey === shown,
          `scope ${JSON.stringify(scope)}: the warm-up lays out a different flow than the Graph`
        );
        check(
          graphIdentity(recount(summary, k), scope) === shown,
          `scope ${JSON.stringify(scope)}: live counts change the layout`
        );
      }
    },
    { testCases: 200 }
  ));
