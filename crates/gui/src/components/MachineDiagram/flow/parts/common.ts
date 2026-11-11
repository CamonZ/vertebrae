/** Shared geometry and helpers for the starter part kinds. */
import { RAIL_Y } from "../../MachinePart";
import type { BBox } from "../../ChangeMark";
import { gateV, type GateSpec } from "../../timeline";
import type { PortDef } from "../registry";

export const Y = RAIL_Y;

/** A frame of `w`×`h` centred on the 640×400 part canvas, on the rail. */
export function centred(w: number, h: number): BBox {
  return [(640 - w) / 2, Y - h / 2, w, h];
}

/** Pill gates on every port that sits on a W or E side of the frame. */
export function sideGates(
  ports: Readonly<Record<string, PortDef>>
): GateSpec[] {
  return Object.values(ports)
    .filter((p) => p.side === "W" || p.side === "E")
    .map((p) => gateV(p.x, p.y));
}

/** Seconds a card takes to cross `px` inside a part (thrown spring travel). */
export const crossing = (px: number) => 0.25 + Math.min(0.4, px / 600);
