import { useState } from "react";
import { useEntityPanelStore } from "../../../stores/entityPanelStore";
import type { DiagramTimeline } from "../../MachineDiagram/flow/compile";
import type { FlowPresentation } from "../../MachineDiagram/flow/presentation";
import type { DiagramInteraction } from "../../MachineDiagram/interaction";
import type { AtlasMachineFlow } from "./buildMachineFlow";

/**
 * Global inspector identity is authoritative. Pointer/focus live only for this
 * mounted scene; IDs removed by a new scope are ignored immediately. No live
 * values are fed back into the compiler, worker, or camera.
 */
export function useAtlasPresentation(
  model: AtlasMachineFlow,
  diagram?: DiagramTimeline,
  query = ""
) {
  const selection = useEntityPanelStore((s) => s.selection);
  const edge = useEntityPanelStore((s) => s.hoveredEdgeId);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [latestInput, setLatestInput] = useState<"hover" | "focus">("hover");
  const inspect = (channel: "hover" | "focus", id: string | null) => {
    if (channel === "hover") setHover(id);
    else setFocus(id);
    if (id) setLatestInput(channel);
  };
  const valid = (id: string | null) =>
    id && model.selections.has(id) ? id : null;
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
  for (const rail of diagram?.rails ?? []) {
    const metadata = model.transitions.get(rail.id);
    // Inspector handoff rows use backend transition IDs. Machine rail IDs are
    // accepted directly, preserving separate identity for parallel decisions.
    const inspector =
      edge === rail.id ||
      (!!edge &&
        (edge === metadata?.transitionId ||
          edge === `X_${metadata?.transitionId}`)) ||
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
  // Neighbours light without recursively flooding the rest of the graph.
  for (const rail of diagram?.rails ?? [])
    if (rails.has(rail.id)) {
      traced.add(rail.from.part);
      traced.add(rail.to.part);
    }
  const activate = (id: string) => {
    const entity = model.selections.get(id);
    const store = useEntityPanelStore.getState();
    if (entity?.type === "workflow") store.openWorkflow(entity.workflowId);
    else if (entity?.type === "step")
      store.openStep(entity.stepId, entity.workflowId);
  };
  const interaction: DiagramInteraction = {
    onActivatePart: activate,
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
    for (const id of model.selections.keys())
      if (!matches.has(id)) dimmed.add(id);
    for (const rail of diagram?.rails ?? [])
      if (!matches.has(rail.from.part) || !matches.has(rail.to.part))
        dimmed.add(rail.id);
  }
  const presentation: FlowPresentation = {
    dimmed,
    counts,
    selected,
    traced,
    rails,
    onActivateRegion: activate,
    onHoverRegion: (id) => inspect("hover", id),
    onFocusRegion: (id) => inspect("focus", id),
  };
  return { interaction, presentation };
}
