/** version vector: story verbs compile protocol events on the shared clock. */
import { tileSpec } from "../../parts/distributedGeometry";
import {
  versionVectorSpec,
  type VersionVectorExtra,
} from "../../parts/versionVectorSpec";
import type { PartKindDef } from "../registry";
import { sideGates } from "./common";
import { incoming, port } from "./distributedCommon";
const ports = { in: port("W", 180, 200, "in", ["data", "request"]) };
const initial = () => ({
  extra: {
    rings: [],
    tl: [tileSpec(475, 200, "A1 B0", -1, [], { w: 96 })],
  } as VersionVectorExtra,
  vector: [1, 0] as [number, number],
  siblings: false,
  pending: [1, 1] as [number, number],
});
type ProtocolState = ReturnType<typeof initial>;

export const versionVectorPart: PartKindDef<
  Record<string, unknown>,
  ProtocolState
> = {
  kind: "version vector",
  job: versionVectorSpec.job,
  family: "distributed systems",
  footprint: "L",
  bb: versionVectorSpec.bb,
  status: versionVectorSpec.status,
  props: {},
  ports,
  gates: () => sideGates(ports),
  init: initial,
  verbs: {
    record: {
      duration: 0.6,
      card: "optional",
      args: {
        a: { type: "integer", min: 0, max: 1000000, default: 1 },
        b: { type: "integer", min: 0, max: 1000000, default: 1 },
      },
      compile(ctx) {
        const { t, state, args, out } = ctx;
        incoming(ctx, [180, 200], [250, 200]);
        state.pending = [Number(args.a), Number(args.b)];
        out.note(t, `write A${state.pending[0]} B${state.pending[1]}`, "ink");
      },
    },
    compare: {
      duration: 0.6,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        const [a, b] = state.pending,
          [x, y] = state.vector;
        const dominates = a >= x && b >= y,
          older = a <= x && b <= y;
        state.extra.rings.push([t, t + 0.4, dominates ? "green" : "amber"]);
        if (dominates) {
          state.extra.tl
            .filter((q) => q.gone == null)
            .forEach((q) => (q.gone = t + 0.4));
          state.extra.tl.push(
            tileSpec(475, 200, `A${a} B${b}`, t + 0.45, [[t + 0.45, "green"]], {
              w: 96,
            })
          );
          state.vector = [a, b];
          state.siblings = false;
          out.note(t + 0.45, "newer · replace", "green");
        } else if (older) {
          out.note(t + 0.45, "older · keep stored", "dim");
        } else {
          state.siblings = true;
          const current = state.extra.tl.filter((q) => q.gone == null);
          current.forEach((q) => (q.gone = t));
          state.extra.tl.push(
            tileSpec(475, 165, `A${x} B${y}`, t, [[t, "amber"]], { w: 96 })
          );
          state.extra.tl.push(
            tileSpec(475, 235, `A${a} B${b}`, t + 0.45, [[t + 0.45, "amber"]], {
              w: 96,
            })
          );
          out.note(t + 0.45, "concurrent · keep both", "amber");
        }
      },
    },
    merge: {
      duration: 0.5,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        const [a, b] = state.pending;
        state.vector = [
          Math.max(a, state.vector[0]),
          Math.max(b, state.vector[1]) + 1,
        ];
        state.siblings = false;
        state.extra.tl
          .filter((q) => q.gone == null)
          .forEach((q) => (q.gone = t));
        const label = `A${state.vector[0]} B${state.vector[1]}`;
        state.extra.tl.push(
          tileSpec(475, 200, label, t + 0.3, [[t + 0.3, "green"]], { w: 96 })
        );
        state.extra.rings.push([t, t + 0.3, "green"]);
        out.note(t + 0.3, "one value again", "green");
      },
    },
  },
};
