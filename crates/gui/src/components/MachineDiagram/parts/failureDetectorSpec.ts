/** Shared protocol state and geometry; no drawing dependencies. */
import type { LampStep } from "../geometry";
import type { StatusNote } from "../timeline";
import type { PartKindDef } from "../flow/registry";

export interface FailureDetectorExtra {
  beats: number[];
  node: LampStep[];
  vd: StatusNote[];
  vl: LampStep[];
  crash: number | null;
  pause: [number, number] | null;
}

export const failureDetectorSpec = {
  job: "decides who is dead",
  bb: [70, 130, 520, 140],
  status: { x: 320, y: 330 },
} satisfies Pick<PartKindDef, "job" | "bb" | "status">;
