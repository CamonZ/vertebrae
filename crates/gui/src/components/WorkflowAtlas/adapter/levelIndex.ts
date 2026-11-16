import type { AtlasGraphLevel } from "./atlasLevels";
import type { AtlasLevelTarget, AtlasMachineFlow } from "./buildMachineFlow";

/** One row of the list beside a Graph level: an element drawn on it. */
export interface LevelIndexItem {
  /** The part the row points at in the machine scene. */
  readonly id: string;
  readonly name: string;
  /** Size of the element: workflows in a factory, steps in a workflow, a step's type. */
  readonly detail: string;
  /** Tasks currently at the element, and how many of them are running. */
  readonly total: number;
  readonly running: number;
  /** The level the row opens, when it leads one level down. */
  readonly opens?: AtlasLevelTarget;
  /** The step the row inspects (steps level only). */
  readonly step?: { readonly stepId: string; readonly workflowId: string };
}

/**
 * The elements a level draws, in the order the scene lays them out:
 * factory stations, the factory's workflow stations, or the workflow's steps.
 * Handoff stubs and logical endpoints are connections, not elements, so they
 * are not listed.
 */
export function levelIndexItems(
  model: AtlasMachineFlow,
  level: AtlasGraphLevel
): LevelIndexItem[] {
  const items: LevelIndexItem[] = [];
  const seenSteps = new Set<string>();
  for (const part of model.spec.parts) {
    const selection = model.selections.get(part.id);
    const destination = model.destinations?.get(part.id);
    const count = model.counts.get(part.id);
    const base = {
      id: part.id,
      total: count?.total ?? 0,
      running: count?.running ?? 0,
    };
    if (level.kind === "factories") {
      if (part.kind !== "factory" || destination?.level !== "factory") continue;
      items.push({
        ...base,
        name: model.names?.get(part.id) ?? part.label ?? part.id,
        detail: part.job ?? "",
        opens: destination,
      });
    } else if (level.kind === "workflows") {
      if (selection?.type !== "workflow" || destination?.level !== "workflow")
        continue;
      items.push({
        ...base,
        name: model.names?.get(part.id) ?? part.label ?? part.id,
        detail: part.kind === "workflow" ? (part.job ?? "") : "no steps",
        opens: destination,
      });
    } else {
      // A finish with ordering links has a second, logical part; list the step once.
      if (selection?.type !== "step" || part.kind === "topology endpoint")
        continue;
      if (seenSteps.has(selection.stepId)) continue;
      seenSteps.add(selection.stepId);
      items.push({
        ...base,
        name: part.label ?? selection.stepId,
        detail: part.kind,
        step: { stepId: selection.stepId, workflowId: selection.workflowId },
      });
    }
  }
  return items;
}
