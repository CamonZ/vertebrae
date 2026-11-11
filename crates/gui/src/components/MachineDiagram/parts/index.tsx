/* eslint-disable react-refresh/only-export-components -- part definitions sit beside their renderer */
/**
 * Catalogue parts implemented on the motion core, by catalogue name (the
 * same name as the part's flow-spec kind). Component tickets add their parts
 * here and to the dev gallery page.
 */
import type { ChangeMark } from "../accessibility";
import { MachinePart, type PartView } from "../MachinePart";
import {
  statePose,
  type ScenarioTiming,
  type UniversalState,
} from "../universalStates";
import { aggregatorMachine } from "./aggregator";
import { boundaryMachine } from "./boundary";
import { clientMachine } from "./client";
import { joinerMachine } from "./joiner";
import { pipelineMachine } from "./pipeline";
import { poolMachine } from "./pool";
import { routerMachine } from "./router";
import { sourceMachine } from "./source";
import { splitterMachine } from "./splitter";
import { transformMachine } from "./transform";
import { workerMachine } from "./worker";
import type { MachinePartDef } from "./types";

export type { MachinePartDef, PartScenario } from "./types";
export {
  aggregatorMachine,
  boundaryMachine,
  clientMachine,
  joinerMachine,
  pipelineMachine,
  poolMachine,
  routerMachine,
  sourceMachine,
  splitterMachine,
  transformMachine,
  workerMachine,
};

/** Implemented parts, in catalogue order. */
export const MACHINE_PARTS = {
  source: sourceMachine,
  client: clientMachine,
  worker: workerMachine,
  transform: transformMachine,
  router: routerMachine,
  splitter: splitterMachine,
  joiner: joinerMachine,
  aggregator: aggregatorMachine,
  pipeline: pipelineMachine,
  pool: poolMachine,
  boundary: boundaryMachine,
} as const;

export type MachinePartName = keyof typeof MACHINE_PARTS;

/** The part drawing for a catalogue name / flow kind, if implemented. */
export function machinePartFor(name: string): MachinePartDef | undefined {
  return Object.prototype.hasOwnProperty.call(MACHINE_PARTS, name)
    ? (MACHINE_PARTS[name as MachinePartName] as unknown as MachinePartDef)
    : undefined;
}

/** Scenario 0 and 1 timing, as universal-state poses need it. */
export function scenarioTimings(
  def: MachinePartDef
): readonly [ScenarioTiming, ScenarioTiming] {
  const timing = (i: 0 | 1): ScenarioTiming => ({
    period: def.scenarios[i].timeline.period,
    notes: def.scenarios[i].timeline.notes,
    still: def.scenarios[i].still,
  });
  return [timing(0), timing(1)];
}

export type CatalogView =
  | { readonly kind: "scenario"; readonly index: number; readonly t: number }
  | { readonly kind: "state"; readonly state: UniversalState };

export interface CatalogPartProps {
  def: MachinePartDef;
  view: CatalogView;
  change?: ChangeMark;
  changeNote?: string;
  labels?: boolean;
  smear?: boolean;
  reducedMotion?: boolean;
  x?: number;
  y?: number;
  scale?: number;
}

/**
 * One catalogue part in a scenario at time `t`, or in a universal state
 * (its pose taken from scenarios 0 and 1, VL-07). Render inside a MachineDiagram.
 */
export function CatalogPart({
  def,
  view,
  change,
  changeNote,
  labels,
  smear,
  reducedMotion,
  x,
  y,
  scale,
}: CatalogPartProps) {
  let index: number;
  let t: number;
  let partView: PartView;
  let pose: "live" | "idle" | "absent" = "live";
  if (view.kind === "scenario") {
    index = Math.min(view.index, def.scenarios.length - 1);
    t = view.t;
    partView = { kind: "scenario", name: def.scenarios[index].name };
  } else {
    const p = statePose(scenarioTimings(def), view.state);
    index = p.scenario;
    t = p.t;
    pose = p.pose === "removed" ? "absent" : p.pose;
    partView = { kind: "state", state: view.state };
  }
  const sc = def.scenarios[index];
  return (
    <MachinePart
      part={def.part}
      bb={def.bb}
      timeline={sc.timeline}
      t={t}
      view={partView}
      pose={pose}
      change={change}
      changeNote={changeNote}
      status={def.status}
      labels={labels}
      smear={view.kind === "state" ? false : smear}
      reducedMotion={reducedMotion}
      x={x}
      y={y}
      scale={scale}
    >
      {(frame) => def.draw(frame.t, sc.extra)}
    </MachinePart>
  );
}
