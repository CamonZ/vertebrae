/** Shared protocol state and geometry; no drawing dependencies. */
import type { LampStep } from "../geometry";
import type { StatusNote } from "../timeline";
import type { RingEvent } from "./distributedGeometry";
import type { PartKindDef } from "../flow/registry";

export interface QuorumExtra {
  rings: RingEvent[];
  dn: boolean[];
  ver: StatusNote[][];
  lamps: LampStep[][];
  ak: StatusNote[];
}

export const quorumSpec = {
  job: "needs a majority to agree",
  bb: [90, 84, 480, 232],
  status: { x: 320, y: 346 },
} satisfies Pick<PartKindDef, "job" | "bb" | "status">;
