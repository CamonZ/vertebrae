/**
 * The three levels of the Atlas Graph and the machine flow each one draws:
 * between factories, inside a factory (its workflows) and inside a workflow
 * (its steps). One builder serves the live Graph and the layout warm-up, so
 * both lay out exactly the same specs.
 */
import type { JsonValue, PipelineSummary } from "../../../bindings";
import type { FactoryFilterValue } from "../../../utils/workflowFactory";
import { buildMachineFlow, type AtlasMachineFlow } from "./buildMachineFlow";
import { buildFactoryLevel, buildWorkflowLevel } from "./buildStationFlows";

export type AtlasGraphLevel =
  | { readonly kind: "factories" }
  | { readonly kind: "workflows"; readonly factory: FactoryFilterValue }
  | {
      readonly kind: "steps";
      readonly factory: FactoryFilterValue;
      readonly workflowId: string;
    };

/** The level a factory scope and an opened workflow (if any) show. */
export function atlasLevel(
  factory: FactoryFilterValue,
  workflowId: string | null
): AtlasGraphLevel {
  if (factory === null) return { kind: "factories" };
  return workflowId === null
    ? { kind: "workflows", factory }
    : { kind: "steps", factory, workflowId };
}

/** The machine flow a level draws, from the whole project's summary. */
export function buildAtlasLevel(
  summary: PipelineSummary,
  routeConfigs: ReadonlyMap<string, JsonValue | null>,
  level: AtlasGraphLevel,
  scope = ""
): AtlasMachineFlow {
  switch (level.kind) {
    case "factories":
      return buildFactoryLevel(summary, scope);
    case "workflows":
      return buildWorkflowLevel(summary, level.factory, scope);
    case "steps": {
      const workflow = summary.workflows.filter(
        (wf) => wf.id === level.workflowId
      );
      return buildMachineFlow(
        { ...summary, workflows: workflow },
        routeConfigs,
        scope,
        summary
      );
    }
  }
}
