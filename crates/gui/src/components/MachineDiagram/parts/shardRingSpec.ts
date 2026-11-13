/** Shared protocol state and geometry; no drawing dependencies. */
import type { PartKindDef } from "../flow/registry";

export interface ShardRingExtra {
  nodes: [string, number, number][];
  load: Record<string, [number, number][]>;
  pulse: [string, number][];
  arc: [number, number] | null;
  red: number | null;
}

export const shardRingSpec = {
  job: "maps each key to one node",
  bb: [120, 95, 500, 220],
  status: { x: 320, y: 346 },
} satisfies Pick<PartKindDef, "job" | "bb" | "status">;
