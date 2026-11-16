import { useState } from "react";
import { useEntityPanelStore } from "../../../stores/entityPanelStore";
import type { DiagramTimeline } from "../../MachineDiagram/flow/compile";
import type { FlowPresentation } from "../../MachineDiagram/flow/presentation";
import type { DiagramInteraction } from "../../MachineDiagram/interaction";
import type { AtlasLevelTarget, AtlasMachineFlow } from "./buildMachineFlow";

/** One rail of the current trace, as the connections list names it. */
export interface AtlasConnection {
  readonly id: string;
  readonly direction: "in" | "out";
  /** The other end: its workflow, and its step when it is one. */
  readonly workflow: string;
  readonly step?: string;
  readonly label?: string;
  readonly handoff: boolean;
}

/** What the pointer or focus is on, and every rail entering or leaving it. */
export interface AtlasTrace {
  readonly title: string;
  readonly kind: "workflow" | "step" | "rail";
  readonly connections: readonly AtlasConnection[];
}

/**
 * Global inspector identity is authoritative. Pointer/focus live only for this
 * mounted scene; IDs removed by a new scope are ignored immediately. No live
 * values are fed back into the compiler, worker, or camera.
 */
export function useAtlasPresentation(
  model: AtlasMachineFlow,
  diagram?: DiagramTimeline,
  query = "",
  /** Opens the level a station or stub leads to (double-click or Enter). */
  onOpen?: (target: AtlasLevelTarget) => void
) {
  const selection = useEntityPanelStore((s) => s.selection);
  const edge = useEntityPanelStore((s) => s.hoveredEdgeId);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [hoverRail, setHoverRail] = useState<string | null>(null);
  const [latestInput, setLatestInput] = useState<"hover" | "focus">("hover");
  const inspect = (channel: "hover" | "focus", id: string | null) => {
    if (channel === "hover") setHover(id);
    else setFocus(id);
    if (id) setLatestInput(channel);
  };
  const valid = (id: string | null) =>
    id && (model.selections.has(id) || model.destinations?.has(id)) ? id : null;
  // Retire removed IDs, so reintroducing an entity cannot resurrect an old trace.
  if (hover && !valid(hover)) setHover(null);
  if (focus && !valid(focus)) setFocus(null);
  const selected = new Set<string>();
  for (const [id, entity] of model.selections) {
    if (
      entity.type === selection?.type &&
      entity.workflowId === selection.workflowId &&
      (entity.type !== "step" ||
        (selection.type === "step" && entity.stepId === selection.stepId))
    )
      selected.add(id);
  }
  // Clicks focus SVG buttons too. A subsequent pointer entry must be able to
  // replace that trace; leaving either channel restores the remaining one.
  const trace =
    latestInput === "hover"
      ? (valid(hover) ?? valid(focus))
      : (valid(focus) ?? valid(hover));
  const roots = trace ? new Set([trace]) : selected;
  const traced = new Set(roots);
  const rails = new Set<string>();
  const counts = new Map(model.counts);
  for (const g of diagram?.regions ?? []) {
    const workflow = model.selections.get(g.id);
    if (workflow?.type === "workflow") {
      const endpoint = g.parts.find(
        (id) => model.selections.get(id)?.type === "workflow"
      );
      if (endpoint && counts.has(endpoint))
        counts.set(g.id, counts.get(endpoint)!);
      if (endpoint) counts.delete(endpoint);
    }
    if (roots.has(g.id)) for (const id of g.parts) traced.add(id);
  }
  const inspectorRails = new Set<string>();
  // A hovered rail lights itself and both of its ends.
  const pointedRail = diagram?.rails.some((r) => r.id === hoverRail)
    ? hoverRail
    : null;
  if (pointedRail) inspectorRails.add(pointedRail);
  const handoffs = new Set<string>();
  for (const [id, t] of model.transitions)
    if (t.targetWorkflowId !== t.workflowId) handoffs.add(id);
  for (const rail of diagram?.rails ?? []) {
    if (pointedRail) break;
    const metadata = model.transitions.get(rail.id);
    // Inspector handoff rows use backend transition IDs. Machine rail IDs are
    // accepted directly, preserving separate identity for parallel decisions.
    const inspector =
      edge === rail.id ||
      (!!edge &&
        (edge === metadata?.transitionId ||
          edge === `X_${metadata?.transitionId}` ||
          // Station levels aggregate several handoffs on one rail.
          !!metadata?.transitionIds?.some(
            (id) => edge === id || edge === `X_${id}`
          ))) ||
      (!!metadata?.stepId &&
        !!metadata.targetStepId &&
        (edge ===
          `B_${metadata.workflowId}_${metadata.stepId}_${metadata.targetStepId}` ||
          edge ===
            `L_${metadata.workflowId}_${metadata.stepId}_${metadata.targetStepId}`));
    if (inspector) inspectorRails.add(rail.id);
  }
  for (const rail of diagram?.rails ?? []) {
    if (
      inspectorRails.size
        ? inspectorRails.has(rail.id)
        : traced.has(rail.from.part) || traced.has(rail.to.part)
    )
      rails.add(rail.id);
  }
  // Direction relative to the trace, before neighbours join it.
  const own = new Set(traced);
  const flow = new Map<string, "in" | "out">();
  for (const rail of diagram?.rails ?? []) {
    if (!rails.has(rail.id) || pointedRail) continue;
    const from = own.has(rail.from.part);
    const to = own.has(rail.to.part);
    if (from !== to) flow.set(rail.id, from ? "out" : "in");
    // A traced workflow lights what crosses its edge, not its own wiring.
    else if (
      !inspectorRails.size &&
      trace &&
      diagram?.regions.some((g) => g.id === trace)
    )
      rails.delete(rail.id);
  }
  // Neighbours light without recursively flooding the rest of the graph.
  for (const rail of diagram?.rails ?? [])
    if (rails.has(rail.id)) {
      traced.add(rail.from.part);
      traced.add(rail.to.part);
    }
  // A region lights when any of its parts does (neighbours at the overview).
  for (const g of diagram?.regions ?? [])
    if (g.parts.some((id) => traced.has(id))) traced.add(g.id);
  const open = (id: string) => {
    const target = model.destinations?.get(id);
    if (target) onOpen?.(target);
  };
  // A click inspects an entity; a part with nothing to inspect (a factory
  // station, a stub) opens where it leads instead.
  const activate = (id: string) => {
    const entity = model.selections.get(id);
    const store = useEntityPanelStore.getState();
    if (entity?.type === "workflow") store.openWorkflow(entity.workflowId);
    else if (entity?.type === "step")
      store.openStep(entity.stepId, entity.workflowId);
    else open(id);
  };
  const interaction: DiagramInteraction = {
    onActivatePart: activate,
    ...(onOpen && model.destinations?.size
      ? {
          onOpenPart: (id: string) =>
            model.destinations?.has(id) ? open(id) : activate(id),
        }
      : {}),
    onHoverPart: (id) => inspect("hover", id),
    onFocusPart: (id) => inspect("focus", id),
    activePart: [...selected][0] ?? null,
  };
  const dimmed = new Set<string>();
  const q = query.trim().toLocaleLowerCase();
  if (q && !trace && !inspectorRails.size) {
    const matches = new Set<string>();
    for (const region of model.spec.regions ?? []) {
      if (region.label?.toLocaleLowerCase().includes(q)) {
        matches.add(region.id);
        for (const id of region.parts) matches.add(id);
      }
    }
    // Stations and stubs match by their own name.
    for (const [id, name] of model.names ?? [])
      if (name.toLocaleLowerCase().includes(q)) matches.add(id);
    for (const id of [
      ...model.selections.keys(),
      ...(model.destinations?.keys() ?? []),
    ])
      if (!matches.has(id)) dimmed.add(id);
    for (const rail of diagram?.rails ?? [])
      if (!matches.has(rail.from.part) || !matches.has(rail.to.part))
        dimmed.add(rail.id);
  }
  const regionName = new Map<string, string>();
  for (const region of model.spec.regions ?? []) {
    const entity = model.selections.get(region.id);
    if (entity?.type === "workflow")
      regionName.set(entity.workflowId, region.label ?? entity.workflowId);
  }
  const partName = new Map(model.spec.parts.map((p) => [p.id, p.label]));
  const workflowOf = (part: string) => {
    const entity = model.selections.get(part);
    const region = entity ? regionName.get(entity.workflowId) : undefined;
    return region ?? model.names?.get(part) ?? "";
  };
  const stepOf = (part: string) =>
    model.selections.get(part)?.type === "step"
      ? partName.get(part)
      : undefined;
  // The connections list: what the trace is, and each rail into or out of it.
  let traceInfo: AtlasTrace | null = null;
  const railById = new Map((diagram?.rails ?? []).map((r) => [r.id, r]));
  if (pointedRail) {
    const r = railById.get(pointedRail)!;
    traceInfo = {
      title: r.label ?? "Connection",
      kind: "rail",
      connections: [
        { end: r.from.part, direction: "in" as const },
        { end: r.to.part, direction: "out" as const },
      ].map(({ end, direction }) => ({
        id: `${r.id}:${direction}`,
        direction,
        workflow: workflowOf(end),
        step: stepOf(end),
        handoff: handoffs.has(r.id),
      })),
    };
  } else if (trace) {
    const entity = model.selections.get(trace);
    const connections: AtlasConnection[] = [];
    for (const [id, direction] of flow) {
      const r = railById.get(id)!;
      const end = direction === "out" ? r.to.part : r.from.part;
      connections.push({
        id,
        direction,
        workflow: workflowOf(end),
        step: stepOf(end),
        label: r.label,
        handoff: handoffs.has(id),
      });
    }
    traceInfo = {
      title:
        entity?.type === "step"
          ? (partName.get(trace) ?? trace)
          : (regionName.get(entity?.workflowId ?? "") ??
            model.names?.get(trace) ??
            trace),
      kind: entity?.type === "step" ? "step" : "workflow",
      connections,
    };
  }
  const presentation: FlowPresentation = {
    dimmed,
    counts,
    testIds: model.testIds,
    selected,
    traced,
    rails,
    handoffs,
    flow,
    // The hovered or focused part plays its own mechanism.
    preview: trace ?? undefined,
    onHoverRail: setHoverRail,
    onActivateRegion: activate,
    onHoverRegion: (id) => inspect("hover", id),
    onFocusRegion: (id) => inspect("focus", id),
  };
  return {
    interaction,
    presentation,
    trace: traceInfo,
    tracing: !!trace || !!pointedRail,
  };
}
