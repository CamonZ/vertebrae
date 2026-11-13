/** quorum: story verbs compile protocol events on the shared clock. */
import { quorumSpec, type QuorumExtra } from "../../parts/quorumSpec";
import { dot } from "../../timeline";
import type { PartKindDef } from "../registry";
import { sideGates } from "./common";
import { incoming, port } from "./distributedCommon";

const ports = {
  in: port("W", 90, 200, "in", ["request", "data"]),
  r1: port("E", 570, 110, "both", ["request", "signal"]),
  r2: port("E", 570, 200, "both", ["request", "signal"]),
  r3: port("E", 570, 290, "both", ["request", "signal"]),
};
const initial = () => ({
  extra: {
    rings: [],
    dn: [false, false, false],
    ver: [1, 2, 3].map((i) => [[0, `r${i} · v7`, "ink"]]),
    lamps: [1, 2, 3].map(() => [[0, "green"]]),
    ak: [[0, "acks 0 / 2", "dim"]],
  } as QuorumExtra,
  acks: [] as number[],
  started: 0,
});
type ProtocolState = ReturnType<typeof initial>;

export const quorumPart: PartKindDef<Record<string, unknown>, ProtocolState> = {
  kind: "quorum",
  job: quorumSpec.job,
  family: "distributed systems",
  footprint: "L",
  bb: quorumSpec.bb,
  status: quorumSpec.status,
  props: {},
  ports,
  gates: () => sideGates(ports),
  init: initial,
  verbs: {
    replicate: {
      duration: 1.1,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.acks = [];
        state.started = t;
        incoming(ctx, [90, 200], [140, 200]);
        [110, 200, 290].forEach((y) =>
          out.card(
            dot(
              [
                [240, 200],
                [330, 200],
                [330, y],
                [430, y],
              ],
              t + 0.5,
              0.55
            )
          )
        );
        state.extra.ak.push([t, "acks 0 / 2", "dim"]);
        out.note(t, "write · need 2 of 3", "ink");
        out.note(t + 0.5, "sent to 3", "dim");
      },
    },
    ack: {
      duration: 0.6,
      card: "optional",
      args: { replica: { type: "integer", min: 1, max: 3, default: 1 } },
      compile(ctx) {
        const { t, state, args, out } = ctx;
        const i = Number(args.replica);
        if (!state.acks.includes(i)) state.acks.push(i);
        const y = [110, 200, 290][i - 1];
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
        state.extra.ver[i - 1].push([t, `r${i} · v8`, "ink"]);
        state.extra.ak.push([
          t,
          `acks ${state.acks.length} / 2`,
          state.acks.length >= 2 ? "green" : "amber",
        ]);
        out.note(
          t,
          `${state.acks.length} ack${state.acks.length === 1 ? "" : "s"} · waiting`,
          "amber"
        );
      },
    },
    decide: {
      duration: 0.4,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        const ok = state.acks.length >= 2;
        state.extra.rings.push([state.started, t, ok ? "green" : "red"]);
        out.note(
          t,
          ok
            ? `${state.acks.length} acks · quorum · ok`
            : "no quorum · write fails",
          ok ? "green" : "red"
        );
        return { role: ok ? "green" : "red" };
      },
    },
    fail: {
      duration: 0.4,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.extra.rings.push([state.started, t, "red"]);
        out.note(t, "no quorum · write fails", "red");
      },
    },
  },
};
