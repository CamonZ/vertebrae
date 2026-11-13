/** Shared protocol state and geometry; no drawing dependencies. */
import type { RingEvent, TileSpec } from "./distributedGeometry";
import type { PartKindDef } from "../flow/registry";

export interface VersionVectorExtra {
  rings: RingEvent[];
  tl: TileSpec[];
}

export const versionVectorSpec = {
  job: "spots concurrent writes",
  bb: [180, 110, 410, 180],
  status: { x: 320, y: 322 },
} satisfies Pick<PartKindDef, "job" | "bb" | "status">;
