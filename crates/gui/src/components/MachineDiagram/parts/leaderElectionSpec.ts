/** Shared protocol state and geometry; no drawing dependencies. */
import type { LampStep } from "../geometry";
import type { StateRole } from "../palette";
import type { Point } from "../route";
import type { StatusNote } from "../timeline";
import type { PartKindDef } from "../flow/registry";

export interface LeaderElectionExtra {
  lamps: LampStep[][];
  halo: [number, number][][];
  rings: [number, number, number, StateRole][];
  term: StatusNote[];
  cut: number | null;
}

export const EL: Point[] = [
  [320, 105],
  [415, 174],
  [379, 286],
  [261, 286],
  [225, 174],
];

export const leaderElectionSpec = {
  job: "picks one leader per term",
  bb: [190, 70, 260, 260],
  status: { x: 320, y: 352 },
} satisfies Pick<PartKindDef, "job" | "bb" | "status">;
