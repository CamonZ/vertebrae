import { useMemo } from "react";
import type { JsonValue, PipelineSummary } from "../../../bindings";
import type { FlowRegistry } from "../../MachineDiagram/flow/registry";
import type { FlowSpec } from "../../MachineDiagram/flow/spec";
import { useLaidOutFlow } from "../../MachineDiagram/flow/useLaidOutFlow";
import { buildMachineFlow } from "./buildMachineFlow";

/** Shares compilation, worker lifecycle and geometric cache with embedded flows. */
export function useAtlasMachineFlow(
  summary: PipelineSummary,
  routeConfigs: ReadonlyMap<string, JsonValue | null> = new Map(),
  scope = "",
  registry?: FlowRegistry
) {
  const adapted = buildMachineFlow(summary, routeConfigs, scope);
  const { structuralKey } = adapted;
  // Internal serialized data only. Structural equality keeps the shared hook's
  // input stable across live counts, hover/selection and recreated summaries.
  const spec = useMemo(
    () => (JSON.parse(structuralKey) as { spec: FlowSpec }).spec,
    [structuralKey]
  );
  const layout = useLaidOutFlow(spec, { registry });
  return { ...adapted, spec, layout };
}
