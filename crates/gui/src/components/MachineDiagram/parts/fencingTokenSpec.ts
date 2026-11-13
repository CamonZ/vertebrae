/** Shared protocol state and geometry; no drawing dependencies. */
import type { LampStep } from "../geometry";
import type { CardRole } from "../palette";
import type { StatusNote } from "../timeline";
import type { RingEvent } from "./distributedGeometry";
import type { PartKindDef } from "../flow/registry";

export interface FencingTokenExtra {
  tok: StatusNote[][];
  cl: LampStep[][];
  max: StatusNote[];
  rings: RingEvent[];
  data: [number, CardRole][];
  nocheck: boolean;
  pause: [number, number] | null;
}

export const fencingTokenSpec = {
  job: "stops a stale holder writing",
  bb: [40, 150, 550, 160],
  status: { x: 320, y: 340 },
} satisfies Pick<PartKindDef, "job" | "bb" | "status">;
