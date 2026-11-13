/** fencing token: story verbs compile protocol events on the shared clock. */
import {
  fencingTokenSpec,
  type FencingTokenExtra,
} from "../../parts/fencingTokenSpec";
import type { PartKindDef } from "../registry";
import { sideGates } from "./common";
import { incoming, port } from "./distributedCommon";

const ports = {
  in: port("W", 380, 225, "in", ["request", "data"]),
  out: port("E", 590, 225, "out", ["result", "data"]),
};
const initial = () => ({
  extra: {
    tok: [[[0, "A", "dim"]], [[0, "B", "dim"]]],
    cl: [[[0, "off"]], [[0, "off"]]],
    max: [[0, "33", "ink"]],
    rings: [],
    data: [[0, "ink"]],
    nocheck: false,
    pause: null,
  } as FencingTokenExtra,
  max: 33,
  token: 34,
});
type ProtocolState = ReturnType<typeof initial>;

export const fencingTokenPart: PartKindDef<
  Record<string, unknown>,
  ProtocolState
> = {
  kind: "fencing token",
  job: fencingTokenSpec.job,
  family: "distributed systems",
  footprint: "L",
  bb: fencingTokenSpec.bb,
  status: fencingTokenSpec.status,
  props: {},
  ports,
  gates: () => sideGates(ports),
  init: initial,
  verbs: {
    fence: {
      duration: 0.4,
      card: "optional",
      args: { token: { type: "integer", min: 0, max: 1000000, default: 34 } },
      compile(ctx) {
        const { t, state, args, out } = ctx;
        state.token = Number(args.token);
        state.extra.tok[1].push([t, `B · ${state.token}`, "ink"]);
        state.extra.cl[1].push([t, "green"]);
        out.note(t, `B holds lease · token ${state.token}`, "ink");
      },
    },
    record: {
      duration: 0.6,
      card: "optional",
      args: { token: { type: "integer", min: 0, max: 1000000 } },
      compile(ctx) {
        const { t, state, args, out } = ctx;
        const previousMax = state.max;
        const token = Number(args.token ?? state.token),
          ok = token >= state.max;
        incoming(ctx, [380, 225], [440, 225]);
        state.extra.rings.push([t, t + 0.5, ok ? "green" : "red"]);
        if (ok) {
          state.max = token;
          state.extra.max.push([t + 0.5, String(token), "ink"]);
          state.extra.data.push([t + 0.5, "green"]);
        }
        out.note(
          t + 0.5,
          ok
            ? `${token} ≥ ${previousMax} · accepted`
            : `rejected · ${token} < ${state.max}`,
          ok ? "green" : "red"
        );
        return {
          role: ok ? "green" : "red",
          exit: ok ? "out" : undefined,
          consumed: !ok,
          token: "result",
        };
      },
    },
    fail: {
      duration: 0.4,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.extra.rings.push([t, t + 0.3, "red"]);
        out.note(t, "stale token rejected", "red");
        return { role: "red", consumed: true };
      },
    },
  },
};
