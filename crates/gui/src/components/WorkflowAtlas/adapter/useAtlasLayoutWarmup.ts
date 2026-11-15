import { useEffect, useMemo } from "react";
import type {
  JsonValue,
  PipelineSummary,
  RouteStepConfig,
} from "../../../bindings";
import { useSteps } from "../../../hooks/useStep";
import {
  compileFlow,
  type CompiledFlow,
} from "../../MachineDiagram/flow/compile";
import { needsAutoLayout } from "../../MachineDiagram/flow/layout";
import { layoutFlowOffThread } from "../../MachineDiagram/flow/layoutClient";
import {
  NO_FACTORY_SCOPE,
  factoryNames,
  filterByFactory,
  hasNoFactory,
  type FactoryFilterValue,
} from "../../../utils/workflowFactory";
import { buildMachineFlow } from "./buildMachineFlow";

/** Delay before warming starts, and between scopes, to stay out of the way. */
const WARMUP_DELAY_MS = 750;

/** Every Graph the Atlas can show: each factory, the unassigned scope, and all. */
export function atlasWarmupScopes(
  summary: PipelineSummary
): FactoryFilterValue[] {
  return [
    ...factoryNames(summary.workflows),
    ...(hasNoFactory(summary.workflows) ? [NO_FACTORY_SCOPE] : []),
    null,
  ];
}

/** The compiled flow a scope's Graph lays out, or null when it needs no layout. */
export function atlasWarmupFlow(
  summary: PipelineSummary,
  routeConfigs: ReadonlyMap<string, JsonValue | null>,
  scope: FactoryFilterValue
): CompiledFlow | null {
  const scoped =
    scope === null
      ? summary
      : { ...summary, workflows: filterByFactory(summary.workflows, scope) };
  const { spec } = buildMachineFlow(scoped, routeConfigs);
  const compiled = compileFlow(spec);
  return compiled.ok && needsAutoLayout(compiled.flow) ? compiled.flow : null;
}

/** Live counts: they change often and never affect layout. */
const COUNT_FIELDS = new Set([
  "task_counts",
  "pipeline_counts",
  "active_count",
]);
const zeroed = (value: unknown): unknown =>
  typeof value === "number"
    ? 0
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, zeroed(v)])
        )
      : value;
const structureOf = (summary: PipelineSummary) =>
  JSON.stringify(summary, (key, value: unknown) =>
    COUNT_FIELDS.has(key) ? zeroed(value) : value
  );

/**
 * The summary with every live count zeroed: what the warm-up lays out. It
 * keeps the summary's shape, so it builds exactly like the live summary.
 */
export const atlasTopology = (summary: PipelineSummary): PipelineSummary =>
  JSON.parse(structureOf(summary)) as PipelineSummary;

/**
 * Precompute the machine-graph layout of every factory in the background
 * once the topology and its route configs have loaded. Each workflow's
 * layout is persisted, so opening any factory later (or after a restart)
 * only composes cached workflows. Requests run at background priority: the
 * Graph on screen always jumps the queue.
 */
export function useAtlasLayoutWarmup(summary: PipelineSummary | null): void {
  const structure = summary ? structureOf(summary) : null;
  const topology = useMemo(
    () =>
      structure === null ? null : (JSON.parse(structure) as PipelineSummary),
    [structure]
  );
  const routeStepIds = useMemo(
    () =>
      (topology?.workflows ?? []).flatMap((workflow) =>
        workflow.workflow_steps
          .filter((step) => step.step_type === "route")
          .map((step) => step.id)
      ),
    [topology]
  );
  const routeSteps = useSteps(routeStepIds);
  const loaded = routeSteps.every((step) => step !== null);
  const routeConfigsKey = loaded
    ? JSON.stringify(
        routeSteps.map((step) =>
          step?.step_type === "route"
            ? ((step.config as RouteStepConfig | null)?.route_config ?? null)
            : null
        )
      )
    : null;
  useEffect(() => {
    if (!topology || routeConfigsKey === null) return;
    const configs = JSON.parse(routeConfigsKey) as (JsonValue | null)[];
    const routeConfigs = new Map(
      routeStepIds.map((id, index) => [id, configs[index]])
    );
    const abort = new AbortController();
    const scopes = atlasWarmupScopes(topology);
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      const scope = scopes.shift();
      if (scope === undefined || abort.signal.aborted) return;
      const flow = atlasWarmupFlow(topology, routeConfigs, scope);
      if (flow)
        layoutFlowOffThread(flow, {
          composite: true,
          priority: "background",
          signal: abort.signal,
        }).catch(() => undefined);
      timer = setTimeout(next, WARMUP_DELAY_MS);
    };
    timer = setTimeout(next, WARMUP_DELAY_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [topology, routeStepIds, routeConfigsKey]);
}
