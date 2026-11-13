import { failureDetectorPart } from "./failureDetector";
import { fencingTokenPart } from "./fencingToken";
import { gossipPart } from "./gossip";
import { leaderElectionPart } from "./leaderElection";
import { quorumPart } from "./quorum";
import { replicationPart } from "./replication";
import { serviceRegistryPart } from "./serviceRegistry";
import { shardRingPart } from "./shardRing";
import { twoPhaseCommitPart } from "./twoPhaseCommit";
import { versionVectorPart } from "./versionVector";
/**
 * Built-in part kinds. Component tickets register the rest of the
 * catalogue's parts here as they land (`registry.parts.register(def)`); each
 * kind's name matches its part drawing in ../../parts.
 */
import type { AnyPartKind, PartRegistry } from "../registry";
import { aggregatorPart } from "./aggregator";
import { alertPart } from "./alert";
import { approvalPart } from "./approval";
import { boundaryPart } from "./boundary";
import { cachePart } from "./cache";
import { circuitBreakerPart } from "./circuitBreaker";
import { clientPart } from "./client";
import { consumerOffsetPart } from "./consumerOffset";
import { deciderPart } from "./decider";
import { documentPart } from "./document";
import { eventRailPart } from "./eventRail";
import { eventStorePart } from "./eventStore";
import { executeStepPart } from "./executeStep";
import { guardPart } from "./guard";
import { humanGatePart } from "./humanGate";
import { idempotencyGuardPart } from "./idempotencyGuard";
import { inferenceStepPart } from "./inferenceStep";
import { joinerPart } from "./joiner";
import { lockPart } from "./lock";
import { metricPart } from "./metric";
import { outboxPart } from "./outbox";
import { pipelinePart } from "./pipeline";
import { poolPart } from "./pool";
import { projectionPart } from "./projection";
import { queuePart } from "./queue";
import { rateLimiterPart } from "./rateLimiter";
import { reactiveCellPart } from "./reactiveCell";
import { replayPart } from "./replay";
import { retryPart } from "./retry";
import { routerPart } from "./router";
import { routeStepPart } from "./routeStep";
import { runEndPart } from "./runEnd";
import { sagaPart } from "./saga";
import { schemaPart } from "./schema";
import { sessionPart } from "./session";
import { snapshotPart } from "./snapshot";
import { sourcePart } from "./source";
import { splitterPart } from "./splitter";
import { stateMachinePart } from "./stateMachine";
import { storePart } from "./store";
import { structuredStepPart } from "./structuredStep";
import { taskRunPart } from "./taskRun";
import { timeoutPart } from "./timeout";
import { tracePart } from "./trace";
import { transactionPart } from "./transaction";
import { transformPart } from "./transform";
import { upcasterPart } from "./upcaster";
import { waitChildrenPart } from "./waitChildren";
import { workerPart } from "./worker";

export const STARTER_PARTS: readonly AnyPartKind[] = [
  sourcePart,
  clientPart,
  workerPart,
  transformPart,
  routerPart,
  splitterPart,
  joinerPart,
  aggregatorPart,
  pipelinePart,
  poolPart,
  storePart,
  cachePart,
  documentPart,
  stateMachinePart,
  reactiveCellPart,
  schemaPart,
  transactionPart,
  lockPart,
  boundaryPart,
  sessionPart,
  guardPart,
  eventRailPart,
  queuePart,
  retryPart,
  timeoutPart,
  rateLimiterPart,
  circuitBreakerPart,
  approvalPart,
  metricPart,
  tracePart,
  alertPart,
  eventStorePart,
  deciderPart,
  projectionPart,
  snapshotPart,
  replayPart,
  upcasterPart,
  sagaPart,
  outboxPart,
  consumerOffsetPart,
  idempotencyGuardPart,
  replicationPart,
  quorumPart,
  leaderElectionPart,
  failureDetectorPart,
  gossipPart,
  shardRingPart,
  versionVectorPart,
  fencingTokenPart,
  twoPhaseCommitPart,
  serviceRegistryPart,
  inferenceStepPart,
  structuredStepPart,
  executeStepPart,
  routeStepPart,
  waitChildrenPart,
  humanGatePart,
  runEndPart,
  taskRunPart,
];

export function registerStarterParts(r: PartRegistry): void {
  for (const def of STARTER_PARTS) r.register(def);
}

export {
  aggregatorPart,
  alertPart,
  approvalPart,
  boundaryPart,
  cachePart,
  circuitBreakerPart,
  clientPart,
  consumerOffsetPart,
  deciderPart,
  documentPart,
  eventRailPart,
  eventStorePart,
  executeStepPart,
  failureDetectorPart,
  fencingTokenPart,
  gossipPart,
  guardPart,
  humanGatePart,
  idempotencyGuardPart,
  inferenceStepPart,
  joinerPart,
  leaderElectionPart,
  lockPart,
  metricPart,
  outboxPart,
  pipelinePart,
  poolPart,
  projectionPart,
  queuePart,
  quorumPart,
  rateLimiterPart,
  reactiveCellPart,
  replayPart,
  replicationPart,
  retryPart,
  routerPart,
  routeStepPart,
  runEndPart,
  sagaPart,
  schemaPart,
  serviceRegistryPart,
  sessionPart,
  shardRingPart,
  snapshotPart,
  sourcePart,
  splitterPart,
  stateMachinePart,
  storePart,
  structuredStepPart,
  taskRunPart,
  timeoutPart,
  tracePart,
  transactionPart,
  transformPart,
  twoPhaseCommitPart,
  upcasterPart,
  versionVectorPart,
  waitChildrenPart,
  workerPart,
};
