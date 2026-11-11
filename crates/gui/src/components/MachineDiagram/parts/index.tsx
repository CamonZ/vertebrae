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
import { alertMachine } from "./alert";
import { approvalMachine } from "./approval";
import { circuitBreakerMachine } from "./circuitBreaker";
import { eventRailMachine } from "./eventRail";
import { guardMachine } from "./guard";
import { metricMachine } from "./metric";
import { queueMachine } from "./queue";
import { rateLimiterMachine } from "./rateLimiter";
import { retryMachine } from "./retry";
import { timeoutMachine } from "./timeout";
import { traceMachine } from "./trace";
import { boundaryMachine } from "./boundary";
import { cacheMachine } from "./cache";
import { clientMachine } from "./client";
import { documentMachine } from "./document";
import { joinerMachine } from "./joiner";
import { lockMachine } from "./lock";
import { pipelineMachine } from "./pipeline";
import { poolMachine } from "./pool";
import { reactiveCellMachine } from "./reactiveCell";
import { routerMachine } from "./router";
import { schemaMachine } from "./schema";
import { sessionMachine } from "./session";
import { sourceMachine } from "./source";
import { splitterMachine } from "./splitter";
import { stateMachineMachine } from "./stateMachine";
import { storeMachine } from "./store";
import { transactionMachine } from "./transaction";
import { transformMachine } from "./transform";
import { workerMachine } from "./worker";
import { eventStoreMachine } from "./eventStore";
import { deciderMachine } from "./decider";
import { projectionMachine } from "./projection";
import { snapshotMachine } from "./snapshot";
import { replayMachine } from "./replay";
import { upcasterMachine } from "./upcaster";
import { sagaMachine } from "./saga";
import { outboxMachine } from "./outbox";
import { consumerOffsetMachine } from "./consumerOffset";
import { idempotencyGuardMachine } from "./idempotencyGuard";
import { replicationMachine } from "./replication";
import { quorumMachine } from "./quorum";
import { leaderElectionMachine } from "./leaderElection";
import { failureDetectorMachine } from "./failureDetector";
import { gossipMachine } from "./gossip";
import { shardRingMachine } from "./shardRing";
import { versionVectorMachine } from "./versionVector";
import { fencingTokenMachine } from "./fencingToken";
import { serviceRegistryMachine } from "./serviceRegistry";
import { twoPhaseCommitMachine } from "./twoPhaseCommit";
import { inferenceStepMachine } from "./inferenceStep";
import { structuredStepMachine } from "./structuredStep";
import { executeStepMachine } from "./executeStep";
import { routeStepMachine } from "./routeStep";
import { waitChildrenMachine } from "./waitChildren";
import { humanGateMachine } from "./humanGate";
import { runEndMachine } from "./runEnd";
import { taskRunMachine } from "./taskRun";
import type { MachinePartDef } from "./types";

export type { MachinePartDef, PartScenario } from "./types";
export {
  replicationMachine,
  quorumMachine,
  leaderElectionMachine,
  failureDetectorMachine,
  gossipMachine,
  shardRingMachine,
  versionVectorMachine,
  fencingTokenMachine,
  serviceRegistryMachine,
  twoPhaseCommitMachine,
  aggregatorMachine,
  alertMachine,
  approvalMachine,
  circuitBreakerMachine,
  eventRailMachine,
  guardMachine,
  metricMachine,
  queueMachine,
  rateLimiterMachine,
  retryMachine,
  timeoutMachine,
  traceMachine,
  boundaryMachine,
  cacheMachine,
  clientMachine,
  documentMachine,
  joinerMachine,
  lockMachine,
  pipelineMachine,
  poolMachine,
  reactiveCellMachine,
  routerMachine,
  schemaMachine,
  sessionMachine,
  sourceMachine,
  splitterMachine,
  stateMachineMachine,
  storeMachine,
  transactionMachine,
  transformMachine,
  workerMachine,
  eventStoreMachine,
  deciderMachine,
  projectionMachine,
  snapshotMachine,
  replayMachine,
  upcasterMachine,
  sagaMachine,
  outboxMachine,
  consumerOffsetMachine,
  idempotencyGuardMachine,
  inferenceStepMachine,
  structuredStepMachine,
  executeStepMachine,
  routeStepMachine,
  waitChildrenMachine,
  humanGateMachine,
  runEndMachine,
  taskRunMachine,
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
  store: storeMachine,
  cache: cacheMachine,
  document: documentMachine,
  "state machine": stateMachineMachine,
  "reactive cell": reactiveCellMachine,
  schema: schemaMachine,
  transaction: transactionMachine,
  lock: lockMachine,
  queue: queueMachine,
  "event rail": eventRailMachine,
  retry: retryMachine,
  timeout: timeoutMachine,
  "rate limiter": rateLimiterMachine,
  "circuit breaker": circuitBreakerMachine,
  guard: guardMachine,
  approval: approvalMachine,
  boundary: boundaryMachine,
  session: sessionMachine,
  metric: metricMachine,
  trace: traceMachine,
  alert: alertMachine,
  "event store": eventStoreMachine,
  decider: deciderMachine,
  projection: projectionMachine,
  snapshot: snapshotMachine,
  replay: replayMachine,
  upcaster: upcasterMachine,
  saga: sagaMachine,
  outbox: outboxMachine,
  "consumer offset": consumerOffsetMachine,
  "idempotency guard": idempotencyGuardMachine,
  replication: replicationMachine,
  quorum: quorumMachine,
  "leader election": leaderElectionMachine,
  "failure detector": failureDetectorMachine,
  gossip: gossipMachine,
  "shard ring": shardRingMachine,
  "version vector": versionVectorMachine,
  "fencing token": fencingTokenMachine,
  "two-phase commit": twoPhaseCommitMachine,
  "service registry": serviceRegistryMachine,
  "inference step": inferenceStepMachine,
  "structured step": structuredStepMachine,
  "execute step": executeStepMachine,
  "route step": routeStepMachine,
  "wait children": waitChildrenMachine,
  "human gate": humanGateMachine,
  "run end": runEndMachine,
  "task run": taskRunMachine,
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
