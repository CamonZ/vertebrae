/** Shared protocol state and geometry; no drawing dependencies. */
import type { LampStep } from "../geometry";
import type { StateRole } from "../palette";
import type { TileSpec } from "./distributedGeometry";
import type { PartKindDef } from "../flow/registry";

export interface ServiceRegistryExtra {
  lamps: LampStep[][];
  rings: [number, number, number, StateRole][];
  crash: number | null;
  tl: TileSpec[];
}

export const serviceRegistrySpec = {
  job: "maps names to addresses",
  bb: [40, 90, 550, 240],
  status: { x: 300, y: 350 },
} satisfies Pick<PartKindDef, "job" | "bb" | "status">;
