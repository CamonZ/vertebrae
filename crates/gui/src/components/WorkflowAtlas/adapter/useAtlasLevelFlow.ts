import { useMemo } from "react";
import type { JsonValue, PipelineSummary } from "../../../bindings";
import type { FlowSpec } from "../../MachineDiagram/flow/spec";
import { useLaidOutFlow } from "../../MachineDiagram/flow/useLaidOutFlow";
import { buildAtlasLevel, type AtlasGraphLevel } from "./atlasLevels";

/**
 * One Graph level, laid out through the shared compiler/worker/cache. Like
 * `useAtlasMachineFlow`, the spec identity follows the structural key only,
 * so live counts and hover never start a layout.
 */
export function useAtlasLevelFlow(
  summary: PipelineSummary,
  routeConfigs: ReadonlyMap<string, JsonValue | null>,
  level: AtlasGraphLevel,
  scope = ""
) {
  const adapted = buildAtlasLevel(summary, routeConfigs, level, scope);
  const { structuralKey } = adapted;
  const spec = useMemo(
    () => (JSON.parse(structuralKey) as { spec: FlowSpec }).spec,
    [structuralKey]
  );
  // The warm-up lays out with the same options, so its cache entries serve.
  const layout = useLaidOutFlow(spec, { composite: true });
  return { ...adapted, spec, layout };
}
