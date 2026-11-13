/** Shared protocol state and geometry; no drawing dependencies. */
import type { LampStep } from "../geometry";
import type { StateRole } from "../palette";
import type { StatusNote } from "../timeline";
import type { PartKindDef } from "../flow/registry";

export interface TwoPhaseExtra {
  readonly lamps: readonly (readonly LampStep[])[];
  readonly rings: readonly (readonly [number, number, StateRole])[];
  readonly phase: readonly StatusNote[];
  readonly crash: number | null;
  readonly spin: readonly [number, number] | null;
}

export const twoPhaseCommitSpec = {
  job: "all commit or none do",
  bb: [70, 84, 500, 232],
  status: { x: 320, y: 346 },
} satisfies Pick<PartKindDef, "job" | "bb" | "status">;
