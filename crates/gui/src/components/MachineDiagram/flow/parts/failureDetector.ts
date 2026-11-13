/** failure detector: story verbs compile protocol events on the shared clock. */
import {
  failureDetectorSpec,
  type FailureDetectorExtra,
} from "../../parts/failureDetectorSpec";
import { dot } from "../../timeline";
import type { PartKindDef } from "../registry";
import { sideGates } from "./common";
import { port } from "./distributedCommon";

const ports = {
  heartbeat: port("W", 200, 200, "in", ["signal"]),
  status: port("E", 400, 200, "out", ["signal"]),
};
const initial = () => ({
  extra: {
    beats: [],
    node: [[0, "green"]],
    vd: [[0, "alive", "green"]],
    vl: [[0, "green"]],
    crash: null,
    pause: null,
  } as FailureDetectorExtra,
});
type ProtocolState = ReturnType<typeof initial>;

export const failureDetectorPart: PartKindDef<
  Record<string, unknown>,
  ProtocolState
> = {
  kind: "failure detector",
  job: failureDetectorSpec.job,
  family: "distributed systems",
  footprint: "L",
  bb: failureDetectorSpec.bb,
  status: failureDetectorSpec.status,
  props: {},
  ports,
  gates: () => sideGates(ports),
  init: initial,
  verbs: {
    heartbeat: {
      duration: 0.5,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        out.card(
          dot(
            [
              [157, 200],
              [426, 200],
            ],
            t,
            0.45
          )
        );
        state.extra.beats.push(t + 0.45);
        state.extra.node.push([t + 0.45, "green"]);
        state.extra.vd.push([t + 0.45, "alive", "green"]);
        state.extra.vl.push([t + 0.45, "green"]);
        out.note(t + 0.45, "alive · timer resets", "green");
      },
    },
    wait: {
      duration: 0.7,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, out } = ctx;
        out.note(t, "waiting for heartbeat", "amber");
      },
    },
    suspect: {
      duration: 0.4,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.extra.vd.push([t, "suspect", "amber"]);
        state.extra.vl.push([t, "amber"]);
        out.note(t, "0.7 s silent · suspect", "amber");
      },
    },
    fail: {
      duration: 0.4,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.extra.crash = t;
        state.extra.node.push([t, "red"]);
        state.extra.vd.push([t, "dead", "red"]);
        state.extra.vl.push([t, "red"]);
        out.note(t, "1.4 s silent · declared dead", "red");
      },
    },
  },
};
