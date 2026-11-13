/** Shared protocol state and geometry; no drawing dependencies. */
import type { LampStep } from "../geometry";
import type { Point } from "../route";
import type { PartKindDef } from "../flow/registry";

export interface GossipExtra {
  lamps: LampStep[][];
  cut: number | null;
  extra: LampStep[] | null;
  xin: number;
}

export const GN: Point[] = [
  [190, 150],
  [320, 150],
  [450, 150],
  [190, 262],
  [320, 262],
  [450, 262],
];

export const gossipSpec = {
  job: "spreads news peer to peer",
  bb: [160, 120, 320, 170],
  status: { x: 320, y: 336 },
} satisfies Pick<PartKindDef, "job" | "bb" | "status">;
