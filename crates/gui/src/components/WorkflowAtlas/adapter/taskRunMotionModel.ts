/**
 * The pure side of TaskRun motion: which rail a step move travels at each
 * Graph level, where a card is along it, and the realtime move source.
 */
import {
  events,
  type PipelineSummary,
  type TaskRunStepChangedEvent,
} from "../../../bindings";
import type { Point } from "../../MachineDiagram/route";
import type { AtlasGraphLevel } from "./atlasLevels";
import { machineId, type AtlasMachineFlow } from "./buildMachineFlow";
import { NO_FACTORY_KEY } from "../factoryOverviewModel";

/** Seconds a card takes to travel its rail. */
export const TRAVEL_MS = 900;
/** Seconds a card rests at its destination under reduced motion. */
export const ARRIVE_MS = 700;
/** At most this many cards travel at once; further moves are not drawn. */
export const MAX_TRAVELLING = 6;

export type MoveSource = (
  onMove: (
    move: Pick<
      TaskRunStepChangedEvent,
      "from_step_id" | "to_step_id" | "task_run_id"
    >
  ) => void
) => () => void;

/** The shipped source: realtime `task_run_step_changed` events. */
export const taskRunMoves: MoveSource = (onMove) => {
  let stop: (() => void) | null = null;
  let cancelled = false;
  void events.taskRunStepChangedEvent
    .listen((event) => onMove(event.payload))
    .then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    stop?.();
  };
};

/**
 * The rail that carries a step move at `level`, or null when the move stays
 * inside one station of the level (or the level does not draw it).
 */
export function railForMove(
  summary: PipelineSummary,
  level: AtlasGraphLevel,
  model: Pick<AtlasMachineFlow, "transitions">,
  fromStepId: string | null,
  toStepId: string | null
): string | null {
  if (!fromStepId || !toStepId) return null;
  const workflowOf = (stepId: string) =>
    summary.workflows.find((wf) =>
      wf.workflow_steps.some((s) => s.id === stepId)
    );
  const from = workflowOf(fromStepId);
  const to = workflowOf(toStepId);
  if (!from || !to) return null;
  if (level.kind === "factories") {
    const a = from.factory_name ?? NO_FACTORY_KEY;
    const b = to.factory_name ?? NO_FACTORY_KEY;
    if (a === b) return null;
    const id = machineId("factory-route", a, b);
    return model.transitions.has(id) ? id : null;
  }
  let fallback: string | null = null;
  for (const [id, t] of model.transitions) {
    if (t.workflowId !== from.id || t.targetWorkflowId !== to.id) continue;
    if (level.kind === "workflows") return id;
    if (from.id === to.id) {
      if (t.stepId === fromStepId && t.targetStepId === toStepId) return id;
    } else if (t.kind === "handoff") {
      if (t.targetStepId === toStepId) return id;
      fallback ??= id;
    }
  }
  return fallback;
}

/** The point `f` (0–1) of the way along a polyline. */
export function along(points: readonly Point[], f: number): Point {
  if (points.length === 0) return [0, 0];
  const lengths = points
    .slice(1)
    .map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  let left = Math.max(0, Math.min(1, f)) * lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] && lengths[i] > 0) {
      const t = left / lengths[i];
      return [
        points[i][0] + (points[i + 1][0] - points[i][0]) * t,
        points[i][1] + (points[i + 1][1] - points[i][1]) * t,
      ];
    }
    left -= lengths[i];
  }
  return points[points.length - 1];
}
