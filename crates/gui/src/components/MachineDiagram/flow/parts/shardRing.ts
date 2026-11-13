/** shard ring: story verbs compile protocol events on the shared clock. */
import { arcPoints, onCircle } from "../../parts/distributedGeometry";
import { shardRingSpec, type ShardRingExtra } from "../../parts/shardRingSpec";
import { dot } from "../../timeline";
import type { PartKindDef } from "../registry";
import { sideGates } from "./common";
import { incoming } from "./distributedCommon";
const ports = {};
const initial = () => ({
  extra: {
    nodes: [
      ["A", 40, -1],
      ["B", 160, -1],
      ["C", 280, -1],
    ],
    load: { A: [[0, 40]], B: [[0, 40]], C: [[0, 40]], D: [[0, 0]] },
    pulse: [],
    arc: null,
    red: null,
  } as ShardRingExtra,
});
type ProtocolState = ReturnType<typeof initial>;

export const shardRingPart: PartKindDef<
  Record<string, unknown>,
  ProtocolState
> = {
  kind: "shard ring",
  job: shardRingSpec.job,
  family: "distributed systems",
  footprint: "L",
  bb: shardRingSpec.bb,
  status: shardRingSpec.status,
  props: {},
  ports,
  gates: () => sideGates(ports),
  init: initial,
  verbs: {
    route: {
      duration: 0.7,
      card: "optional",
      args: { angle: { type: "number", min: 0, max: 359.999, default: 100 } },
      compile(ctx) {
        const { t, state, args, out } = ctx;
        const angle = Number(args.angle);
        const nodes = state.extra.nodes.slice().sort((a, b) => a[1] - b[1]);
        const owner = nodes.find((n) => n[1] >= angle) ?? nodes[0];
        const end = owner[1] < angle ? owner[1] + 360 : owner[1];
        out.card(dot(arcPoints(230, 205, 95, angle, end), t, 0.6));
        incoming(
          ctx,
          onCircle(230, 205, 95, angle),
          onCircle(230, 205, 95, owner[1])
        );
        state.extra.pulse.push([owner[0], t + 0.6]);
        const L = state.extra.load[owner[0]],
          w = L[L.length - 1][1] + 12;
        L.push([t + 0.6, w]);
        if (w > 75) state.extra.red = t + 0.6;
        out.note(
          t + 0.6,
          w > 75
            ? `${owner[0]} over capacity`
            : `next node clockwise · ${owner[0]}`,
          w > 75 ? "red" : "green"
        );
      },
    },
    rebalance: {
      duration: 1,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        if (state.extra.nodes.some((n) => n[0] === "D")) {
          out.note(t, "D already on ring", "dim");
          return;
        }
        state.extra.nodes.push(["D", 100, t]);
        state.extra.arc = [t, t + 1];
        out.card(dot(arcPoints(230, 205, 95, 160, 100), t + 0.2, 0.6, "amber"));
        const b = state.extra.load.B.at(-1)![1],
          moved = Math.min(24, b);
        state.extra.load.B.push([t + 0.8, b - moved]);
        state.extra.load.D.push([t + 0.8, moved]);
        out.note(t, "only 40°–100° moves · B → D", "amber");
        out.note(t + 0.8, "A and C untouched", "green");
      },
    },
  },
};
