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
import { circuitBreakerPart } from "./circuitBreaker";
import { clientPart } from "./client";
import { eventRailPart } from "./eventRail";
import { guardPart } from "./guard";
import { joinerPart } from "./joiner";
import { metricPart } from "./metric";
import { pipelinePart } from "./pipeline";
import { poolPart } from "./pool";
import { queuePart } from "./queue";
import { rateLimiterPart } from "./rateLimiter";
import { retryPart } from "./retry";
import { routerPart } from "./router";
import { sessionPart } from "./session";
import { sourcePart } from "./source";
import { splitterPart } from "./splitter";
import { timeoutPart } from "./timeout";
import { tracePart } from "./trace";
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
  circuitBreakerPart,
  clientPart,
  eventRailPart,
  guardPart,
  joinerPart,
  metricPart,
  pipelinePart,
  poolPart,
  queuePart,
  rateLimiterPart,
  retryPart,
  routerPart,
  sessionPart,
  sourcePart,
  splitterPart,
  timeoutPart,
  tracePart,
  transformPart,
  workerPart,
};
