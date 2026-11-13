/** replication: story verbs compile protocol events on the shared clock. */
import {
  replicationSpec,
  type ReplicationExtra,
} from "../../parts/replicationSpec";
import { dot } from "../../timeline";
import type { PartKindDef } from "../registry";
import { sideGates } from "./common";
import { incoming, port } from "./distributedCommon";

const ports = {
  in: port("W", 80, 200, "in", ["request", "data"]),
  f1: port("E", 580, 140, "out", ["data"]),
  f2: port("E", 580, 260, "out", ["data"]),
  ack: port("E", 580, 200, "in", ["signal"]),
};
const initial = () => ({
  extra: {
    fo: false,
    down: null,
    ver: [[[0, "v7", "ink"]], [[0, "v7", "ink"]], [[0, "v7", "ink"]]],
    role: [
      [[0, "leader", "dim"]],
      [[0, "follower", "dim"]],
      [[0, "follower", "dim"]],
    ],
    lamps: [[[0, "green"]], [[0, "green"]], [[0, "green"]]],
  } as ReplicationExtra,
  version: 7,
  acked: [] as number[],
});
type ProtocolState = ReturnType<typeof initial>;

export const replicationPart: PartKindDef<
  Record<string, unknown>,
  ProtocolState
> = {
  kind: "replication",
  job: replicationSpec.job,
  family: "distributed systems",
  footprint: "L",
  bb: replicationSpec.bb,
  status: replicationSpec.status,
  props: {},
  ports,
  gates: () => sideGates(ports),
  init: initial,
  verbs: {
    replicate: {
      duration: 1.2,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        const v = ++state.version;
        state.acked = [];
        incoming(ctx, [80, 200], [118, 200]);
        state.extra.ver[0].push([t + 0.5, `v${v}`, "ink"]);
        [140, 260].forEach((y) =>
          out.card(
            dot(
              [
                [240, 200],
                [330, 200],
                [330, y],
                [430, y],
              ],
              t + 0.6,
              0.6
            )
          )
        );
        out.note(t, "write", "ink");
        out.note(t + 0.5, `leader at v${v} · copying`, "amber");
      },
    },
    ack: {
      duration: 0.6,
      card: "optional",
      args: { follower: { type: "integer", min: 1, max: 2, default: 1 } },
      compile(ctx) {
        const { t, state, args, out } = ctx;
        const i = Number(args.follower);
        if (!state.acked.includes(i)) state.acked.push(i);
        const y = i === 1 ? 140 : 260;
        out.card(
          dot(
            [
              [430, y],
              [330, y],
              [330, 200],
              [240, 200],
            ],
            t,
            0.55
          )
        );
        state.extra.ver[i].push([t, `v${state.version}`, "ink"]);
        state.extra.lamps[i].push([t, "green"]);
        out.note(
          t,
          `${state.acked.length} of 2 followers at v${state.version}`,
          state.acked.length === 2 ? "green" : "amber"
        );
      },
    },
    commit: {
      duration: 0.4,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        const ok = state.acked.length === 2;
        out.note(
          t,
          ok
            ? `2 of 2 followers at v${state.version}`
            : "followers still catching up",
          ok ? "green" : "amber"
        );
        if (ok)
          out.marker({ t, kind: "checkpoint", label: `v${state.version}` });
        return { role: ok ? "green" : "amber", exit: "f1", token: "data" };
      },
    },
    fail: {
      duration: 0.4,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.extra.down = t;
        state.extra.lamps[0].push([t, "red"]);
        state.extra.role[0].push([t, "down", "red"]);
        out.note(t, "leader crashed", "red");
      },
    },
  },
};
