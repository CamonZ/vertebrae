/**
 * Built-in part kinds. Component tickets register the rest of the
 * catalogue's parts here as they land (`registry.parts.register(def)`); each
 * kind's name matches its part drawing in ../../parts.
 */
import type { AnyPartKind, PartRegistry } from "../registry";
import { aggregatorPart } from "./aggregator";
import { boundaryPart } from "./boundary";
import { clientPart } from "./client";
import { eventRailPart } from "./eventRail";
import { guardPart } from "./guard";
import { joinerPart } from "./joiner";
import { pipelinePart } from "./pipeline";
import { poolPart } from "./pool";
import { routerPart } from "./router";
import { sessionPart } from "./session";
import { sourcePart } from "./source";
import { splitterPart } from "./splitter";
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
];

export function registerStarterParts(r: PartRegistry): void {
  for (const def of STARTER_PARTS) r.register(def);
}

export {
  aggregatorPart,
  boundaryPart,
  clientPart,
  eventRailPart,
  guardPart,
  joinerPart,
  pipelinePart,
  poolPart,
  routerPart,
  sessionPart,
  sourcePart,
  splitterPart,
  transformPart,
  workerPart,
};
