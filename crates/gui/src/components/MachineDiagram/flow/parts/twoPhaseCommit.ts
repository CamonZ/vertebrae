/** two-phase commit: story verbs compile protocol events on the shared clock. */
import { twoPhaseCommitSpec } from "../../parts/twoPhaseCommitSpec";
import { dot } from "../../timeline";
import type { PartKindDef } from "../registry";
import { sideGates } from "./common";
import { incoming, port } from "./distributedCommon";

const ports = {
  in: port("W", 70, 200, "in", ["request"]),
  p1: port("E", 570, 110, "both", ["control", "signal"]),
  p2: port("E", 570, 200, "both", ["control", "signal"]),
  p3: port("E", 570, 290, "both", ["control", "signal"]),
};
const initial = () => ({
  extra: {
    lamps: [1, 2, 3].map(() => [[0, "off"]]),
    rings: [],
    phase: [[0, "idle", "dim"]],
    crash: null,
    spin: null,
  } as {
    lamps: import("../../geometry").LampStep[][];
    rings: [number, number, import("../../palette").StateRole][];
    phase: import("../../timeline").StatusNote[];
    crash: number | null;
    spin: [number, number] | null;
  },
  votes: {} as Record<number, boolean>,
  started: 0,
});
type ProtocolState = ReturnType<typeof initial>;

export const twoPhaseCommitPart: PartKindDef<
  Record<string, unknown>,
  ProtocolState
> = {
  kind: "two-phase commit",
  job: twoPhaseCommitSpec.job,
  family: "distributed systems",
  footprint: "L",
  bb: twoPhaseCommitSpec.bb,
  status: twoPhaseCommitSpec.status,
  props: {},
  ports,
  gates: () => sideGates(ports),
  init: initial,
  verbs: {
    stage: {
      duration: 1.1,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.votes = {};
        state.started = t;
        state.extra.crash = null;
        state.extra.spin = null;
        incoming(ctx, [70, 200], [115, 200]);
        state.extra.phase.push([t + 0.5, "prepare", "amber"]);
        [110, 200, 290].forEach((y, i) => {
          out.card(
            dot(
              [
                [210, 200],
                [330, 200],
                [330, y],
                [420, y],
              ],
              t + 0.5,
              0.55
            )
          );
          state.extra.lamps[i].push([t + 1.05, "amber"]);
        });
        out.note(t, "prepare · locks held", "amber");
      },
    },
    vote: {
      duration: 0.6,
      card: "optional",
      args: {
        participant: { type: "integer", min: 1, max: 3, default: 1 },
        yes: { type: "boolean", default: true },
      },
      compile(ctx) {
        const { t, state, args, out } = ctx;
        const i = Number(args.participant),
          yes = args.yes !== false;
        state.votes[i] = yes;
        const y = [110, 200, 290][i - 1];
        state.extra.lamps[i - 1].push([t, yes ? "amber" : "red"]);
        out.card(
          dot(
            [
              [420, y],
              [330, y],
              [330, 200],
              [210, 200],
            ],
            t,
            0.55,
            yes ? "ink" : "red"
          )
        );
        out.note(
          t,
          yes
            ? `${Object.keys(state.votes).length} prepared · locks held`
            : `p${i} can't prepare`,
          yes ? "amber" : "red"
        );
      },
    },
    commit: {
      duration: 0.7,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        const ok =
          Object.keys(state.votes).length === 3 &&
          Object.values(state.votes).every(Boolean) &&
          state.extra.crash == null;
        if (!ok) {
          out.note(t, "can't commit · need 3 yes votes", "amber");
          return { role: "amber" };
        }
        state.extra.rings.push([state.started, t, "green"]);
        state.extra.phase.push([t, "commit", "green"]);
        [110, 200, 290].forEach((y, i) => {
          out.card(
            dot(
              [
                [210, 200],
                [330, 200],
                [330, y],
                [420, y],
              ],
              t,
              0.55,
              "green"
            )
          );
          state.extra.lamps[i].push([t + 0.6, "green"]);
        });
        out.note(t + 0.6, "all committed", "green");
        out.marker({ t: t + 0.6, kind: "checkpoint", label: "commit" });
        return { role: "green" };
      },
    },
    rollback: {
      duration: 0.7,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.extra.phase.push([t, "abort", "red"]);
        state.extra.rings.push([state.started, t, "red"]);
        [110, 200, 290].forEach((y, i) => {
          out.card(
            dot(
              [
                [210, 200],
                [330, 200],
                [330, y],
                [420, y],
              ],
              t,
              0.55,
              "red"
            )
          );
          state.extra.lamps[i].push([t + 0.6, "off"]);
        });
        state.extra.spin = null;
        state.votes = {};
        out.note(t, "one no · abort all", "red");
        out.note(t + 0.6, "rolled back · locks freed", "dim");
      },
    },
    fail: {
      duration: 0.5,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.extra.crash = t;
        state.extra.spin = [t, 1e9];
        state.extra.phase.push([t, "?", "red"]);
        state.extra.rings.push([state.started, t, "red"]);
        out.note(t, "coordinator crashed", "red");
        out.note(t + 0.3, "blocked · locks held", "red");
      },
    },
  },
};
