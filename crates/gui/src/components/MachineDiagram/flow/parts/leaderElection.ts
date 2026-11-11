/** leader election: story verbs compile protocol events on the shared clock. */
import {
  EL,
  leaderElectionMachine,
  type LeaderElectionExtra,
} from "../../parts/leaderElection";
import { dot } from "../../timeline";
import type { PartKindDef } from "../registry";
import { sideGates } from "./common";
const ports = {};
const initial = () => ({
  extra: {
    lamps: EL.map(() => [[0, "off"]]),
    halo: EL.map(() => [[0, 0]]),
    rings: [],
    term: [[0, "term 1", "ink"]],
    cut: null,
  } as LeaderElectionExtra,
  term: 1,
  candidate: 0,
  votes: [] as number[],
  started: 0,
  leader: -1,
});
type ProtocolState = ReturnType<typeof initial>;
export const leaderElectionPart: PartKindDef<
  Record<string, unknown>,
  ProtocolState
> = {
  kind: "leader election",
  job: leaderElectionMachine.part.job,
  family: "distributed systems",
  footprint: "L",
  bb: leaderElectionMachine.bb,
  status: leaderElectionMachine.status,
  props: {},
  ports,
  gates: () => sideGates(ports),
  init: initial,
  draw: (t, p) => leaderElectionMachine.draw(t, p.state.extra),
  verbs: {
    elect: {
      duration: 0.6,
      card: "optional",
      args: { node: { type: "integer", min: 1, max: 5, default: 1 } },
      compile(ctx) {
        const { t, state, args, out } = ctx;
        state.term++;
        state.candidate = Number(args.node) - 1;
        state.votes = [state.candidate];
        state.started = t;
        state.leader = -1;
        state.extra.halo.forEach((h) => h.push([t, 0]));
        state.extra.term.push([t, `term ${state.term}`, "ink"]);
        state.extra.lamps[state.candidate].push([t, "amber"]);
        EL.forEach((p, i) => {
          if (i !== state.candidate)
            out.card(dot([EL[state.candidate], p], t, 0.5, "dim"));
        });
        out.note(
          t,
          `n${state.candidate + 1} stands · term ${state.term}`,
          "amber"
        );
      },
    },
    vote: {
      duration: 0.6,
      card: "optional",
      args: { node: { type: "integer", min: 1, max: 5, default: 2 } },
      compile(ctx) {
        const { t, state, args, out } = ctx;
        const i = Number(args.node) - 1;
        if (!state.votes.includes(i)) state.votes.push(i);
        out.card(dot([EL[i], EL[state.candidate]], t, 0.5));
        if (state.votes.length >= 3) {
          state.leader = state.candidate;
          state.extra.lamps[state.leader].push([t + 0.5, "green"]);
          state.extra.halo[state.leader].push([t + 0.5, 1]);
          state.extra.rings.push([
            state.candidate,
            state.started,
            t + 0.5,
            "green",
          ]);
          out.note(
            t + 0.5,
            `n${state.leader + 1} leader · term ${state.term}`,
            "green"
          );
        } else
          out.note(t, `${state.votes.length} votes · no majority`, "amber");
      },
    },
    heartbeat: {
      duration: 0.6,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        if (state.leader < 0) {
          out.note(t, "no elected leader", "amber");
          return;
        }
        EL.forEach((p, i) => {
          if (i !== state.leader)
            out.card(dot([EL[state.leader], p], t, 0.5, "dim"));
        });
        out.note(t, "heartbeats hold it", "dim");
      },
    },
    fail: {
      duration: 0.4,
      card: "optional",
      args: {},
      compile(ctx) {
        const { t, state, out } = ctx;
        state.extra.rings.push([state.candidate, state.started, t, "red"]);
        state.extra.halo.forEach((h) => h.push([t, 0]));
        state.leader = -1;
        out.note(t, `${state.votes.length} votes · no majority`, "red");
      },
    },
  },
};
