/** gossip: story verbs compile protocol events on the shared clock. */
import { GN, gossipSpec, type GossipExtra } from "../../parts/gossipSpec";
import { dot } from "../../timeline";
import type { PartKindDef } from "../registry";
import { sideGates } from "./common";
const ports = {};
const initial = () => ({
  extra: {
    lamps: GN.map(() => [[0, "off"]]),
    cut: null,
    extra: null,
    xin: 0,
  } as GossipExtra,
  known: [0],
});
type ProtocolState = ReturnType<typeof initial>;

export const gossipPart: PartKindDef<Record<string, unknown>, ProtocolState> = {
  kind: "gossip",
  job: gossipSpec.job,
  family: "distributed systems",
  footprint: "L",
  bb: gossipSpec.bb,
  status: gossipSpec.status,
  props: {},
  ports,
  gates: () => sideGates(ports),
  init: initial,
  verbs: {
    send: {
      duration: 0.4,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.known = [0];
        state.extra.lamps.forEach((L) => L.push([t, "off"]));
        state.extra.lamps[0].push([t, "ink"]);
        out.note(t, "n1 has news", "ink");
      },
    },
    spread: {
      duration: 0.6,
      card: "optional",
      args: {
        from: { type: "integer", min: 1, max: 6, default: 1 },
        to: { type: "integer", min: 1, max: 6, default: 2 },
      },
      compile(ctx) {
        const { t, state, args, out } = ctx;
        const from = Number(args.from) - 1,
          to = Number(args.to) - 1;
        if (!state.known.includes(from)) {
          out.note(t, `n${from + 1} has no news to spread`, "amber");
          return;
        }
        out.card(dot([GN[from], GN[to]], t, 0.5));
        if (!state.known.includes(to)) state.known.push(to);
        state.extra.lamps[to].push([t + 0.5, "ink"]);
        out.note(
          t + 0.5,
          `${state.known.length} of 6 know`,
          state.known.length === 6 ? "green" : "dim"
        );
      },
    },
    fail: {
      duration: 0.4,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.extra.cut = t;
        [2, 5].forEach((i) => state.extra.lamps[i].push([t, "red"]));
        out.note(t, `${state.known.length} of 6 know · partitioned`, "red");
      },
    },
  },
};
