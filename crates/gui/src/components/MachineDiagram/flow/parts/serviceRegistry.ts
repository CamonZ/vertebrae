/** service registry: story verbs compile protocol events on the shared clock. */
import { tileSpec } from "../../parts/distributedGeometry";
import {
  serviceRegistrySpec,
  type ServiceRegistryExtra,
} from "../../parts/serviceRegistrySpec";
import { dot } from "../../timeline";
import type { PartKindDef } from "../registry";
import { sideGates } from "./common";
import { incoming, port } from "./distributedCommon";
const ports = {
  register: port("E", 440, 130, "in", ["control"]),
  lookup: port("S", 260, 170, "in", ["request"]),
  out: port("W", 200, 130, "out", ["data", "result"]),
};
const initial = () => ({
  extra: {
    lamps: [[[0, "green"]], [[0, "off"]]],
    rings: [],
    crash: null,
    tl: [tileSpec(290, 130, "s1", -1, [], { w: 44 })],
  } as ServiceRegistryExtra,
  registered: false,
  alive: true,
});
type ProtocolState = ReturnType<typeof initial>;

export const serviceRegistryPart: PartKindDef<
  Record<string, unknown>,
  ProtocolState
> = {
  kind: "service registry",
  job: serviceRegistrySpec.job,
  family: "distributed systems",
  footprint: "L",
  bb: serviceRegistrySpec.bb,
  status: serviceRegistrySpec.status,
  props: {},
  ports,
  gates: () => sideGates(ports),
  init: initial,
  verbs: {
    register: {
      duration: 0.7,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.registered = true;
        state.alive = true;
        state.extra.crash = null;
        state.extra.lamps[1].push([t, "green"]);
        out.card(
          dot(
            [
              [590, 301],
              [610, 301],
              [610, 130],
              [440, 130],
            ],
            t,
            0.65
          )
        );
        state.extra.tl.push(
          tileSpec(340, 130, "s2", t + 0.65, [[t + 0.65, "ink"]], { w: 44 })
        );
        out.note(t, "s2 starts · registers", "ink");
      },
    },
    resolve: {
      duration: 2.1,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        incoming(ctx, [260, 170], [290, 130]);
        out.card(
          dot(
            [
              [260, 170],
              [260, 245],
              [150, 245],
            ],
            t + 0.5,
            0.5
          )
        );
        const y = state.registered ? 301 : 226;
        out.card(
          dot(
            [
              [150, 270],
              [300, 270],
              [300, y],
              [450, y],
            ],
            t + 1,
            0.6
          )
        );
        const ok = !state.registered || state.alive;
        state.extra.rings.push([y, t + 1.55, t + 1.95, ok ? "green" : "red"]);
        out.note(
          t + 0.5,
          state.registered ? "gets s1, s2" : "lookup → s1 only",
          "ink"
        );
        out.note(
          t + 1.95,
          ok
            ? `call s${y === 301 ? 2 : 1} · ok`
            : "call s2 · connection refused",
          ok ? "green" : "red"
        );
        return { role: ok ? "green" : "red", exit: "out", token: "data" };
      },
    },
    expire: {
      duration: 0.4,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.registered = false;
        state.extra.tl
          .filter((q) => q.s === "s2" && q.gone == null)
          .forEach((q) => (q.gone = t));
        state.extra.lamps[1].push([t, "off"]);
        out.note(t, "entry removed", "dim");
      },
    },
    fail: {
      duration: 0.4,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.alive = false;
        state.extra.crash = t;
        state.extra.lamps[1].push([t, "red"]);
        out.note(t, "s2 crashes · entry stays", "red");
      },
    },
  },
};
