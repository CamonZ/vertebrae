/**
 * Starter part kinds for the thin slice. Component tickets register the rest
 * of the catalogue's parts as they land (`registry.parts.register(def)`).
 */
import type { AnyPartKind, PartRegistry } from "../registry";
import { clientPart } from "./client";
import { eventRailPart } from "./eventRail";
import { guardPart } from "./guard";
import { sessionPart } from "./session";
import { sourcePart } from "./source";
import { workerPart } from "./worker";

export const STARTER_PARTS: readonly AnyPartKind[] = [
  sourcePart,
  clientPart,
  workerPart,
  sessionPart,
  guardPart,
  eventRailPart,
];

export function registerStarterParts(r: PartRegistry): void {
  for (const def of STARTER_PARTS) r.register(def);
}

export {
  clientPart,
  eventRailPart,
  guardPart,
  sessionPart,
  sourcePart,
  workerPart,
};
