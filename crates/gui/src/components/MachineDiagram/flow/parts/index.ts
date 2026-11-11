/**
 * Built-in part kinds. Component tickets register the rest of the
 * catalogue's parts here as they land (`registry.parts.register(def)`); each
 * kind's name matches its part drawing in ../../parts.
 */
import { FLOW_DRAWINGS } from "../drawings";
import type { AnyPartKind, PartRegistry } from "../registry";
import { aggregatorPart } from "./aggregator";
import { alertPart } from "./alert";
import { approvalPart } from "./approval";
import { boundaryPart } from "./boundary";
import { cachePart } from "./cache";
import { circuitBreakerPart } from "./circuitBreaker";
import { clientPart } from "./client";
import { documentPart } from "./document";
import { eventRailPart } from "./eventRail";
import { guardPart } from "./guard";
import { joinerPart } from "./joiner";
import { lockPart } from "./lock";
import { metricPart } from "./metric";
import { pipelinePart } from "./pipeline";
import { poolPart } from "./pool";
import { queuePart } from "./queue";
import { rateLimiterPart } from "./rateLimiter";
import { reactiveCellPart } from "./reactiveCell";
import { retryPart } from "./retry";
import { routerPart } from "./router";
import { schemaPart } from "./schema";
import { sessionPart } from "./session";
import { sourcePart } from "./source";
import { splitterPart } from "./splitter";
import { stateMachinePart } from "./stateMachine";
import { storePart } from "./store";
import { timeoutPart } from "./timeout";
import { tracePart } from "./trace";
import { transactionPart } from "./transaction";
import { transformPart } from "./transform";
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
];

export function registerStarterParts(r: PartRegistry): void {
  for (const def of STARTER_PARTS) {
    const draw = Object.prototype.hasOwnProperty.call(FLOW_DRAWINGS, def.kind)
      ? FLOW_DRAWINGS[def.kind as keyof typeof FLOW_DRAWINGS]
      : undefined;
    r.register({ ...def, ...(draw ? { draw } : {}) });
  }
}

export {
  aggregatorPart,
  alertPart,
  approvalPart,
  boundaryPart,
  cachePart,
  circuitBreakerPart,
  clientPart,
  documentPart,
  eventRailPart,
  guardPart,
  joinerPart,
  lockPart,
  metricPart,
  pipelinePart,
  poolPart,
  queuePart,
  rateLimiterPart,
  reactiveCellPart,
  retryPart,
  routerPart,
  schemaPart,
  sessionPart,
  sourcePart,
  splitterPart,
  stateMachinePart,
  storePart,
  timeoutPart,
  tracePart,
  transactionPart,
  transformPart,
  workerPart,
};
