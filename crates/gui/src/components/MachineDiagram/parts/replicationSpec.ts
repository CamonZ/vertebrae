/** Shared protocol state and geometry; no drawing dependencies. */
import type { LampStep } from "../geometry";
import type { StatusNote } from "../timeline";
import type { PartKindDef } from "../flow/registry";

export interface ReplicationExtra {
  fo: boolean;
  down: number | null;
  ver: StatusNote[][];
  role: StatusNote[][];
  lamps: LampStep[][];
}

export const replicationSpec = {
  job: "copies writes to followers",
  bb: [80, 95, 500, 210],
  status: { x: 320, y: 340 },
} satisfies Pick<PartKindDef, "job" | "bb" | "status">;
