import { Ring } from "../fixtures";
import { type CardRole, type StateRole } from "../palette";
import { dot, note, seal, story, type StoryDraft } from "../timeline";
import { Cut, Halo, NodeLamp, Readout } from "./distributedFixtures";
import { FadedText } from "./draw";
import {
  EL,
  leaderElectionSpec,
  type LeaderElectionExtra,
} from "./leaderElectionSpec";
import type { MachinePartDef, PartScenario } from "./types";

export type { LeaderElectionExtra } from "./leaderElectionSpec";

/** Gallery reference scenarios; fixtures are evaluated only from frame time. */
const ELab: [number, number, "left" | "right" | "center"][] = [
  [282, 105, "right"],
  [447, 174, "left"],
  [379, 330, "center"],
  [261, 330, "center"],
  [193, 174, "right"],
];
const NAMES = [
  "elected",
  "split vote · new term",
  "partition · minority can't elect",
] as const;
const STILLS = [2.6, 2.6, 4.1];
function leaderElectionStory(index: number): PartScenario<LeaderElectionExtra> {
  const kind = NAMES[index],
    s = kind,
    f = index === 1;
  const S: StoryDraft & LeaderElectionExtra = Object.assign(story(4.6), {
      lamps: [],
      halo: [],
      rings: [],
      term: [],
      cut: null,
    } as LeaderElectionExtra),
    part = s === "partition · minority can't elect";
  const done = (): PartScenario<LeaderElectionExtra> => ({
    name: kind,
    still: STILLS[index],
    timeline: seal(S),
    extra: S,
  });
  S.gates.push();
  S.lamps = EL.map(() => [[0, "off"]]);
  S.halo = EL.map(() => [[0, 0]]);
  S.rings = [];
  S.term = [[0, "term 1", "ink"]];
  S.cut = null;
  const ask = (c: number, to: number[], a: number) => {
    for (const j of to) S.cards.push(dot([EL[c], EL[j]], a, 0.5, "dim"));
  };
  const vote = (
    c: number,
    from: number[],
    a: number,
    col: CardRole = "ink"
  ) => {
    for (const j of from) S.cards.push(dot([EL[j], EL[c]], a, 0.5, col));
  };
  const stand = (c: number, a0: number, a1: number, res: StateRole = "ink") => {
    S.rings.push([c, a0, a1, res]);
    S.lamps[c].push([a1, "amber"]);
  };
  const lead = (c: number, a: number) => {
    S.lamps[c].push([a, "green"]);
    S.halo[c].push([a, 1]);
  };
  if (part) {
    S.period = 5.2;
    lead(0, -1);
    S.cut = 0.6;
    stand(3, 0.9, 1.6);
    S.term.push([1.6, "term 2", "ink"]);
    ask(3, [2, 4], 1.7);
    vote(3, [2, 4], 2.25);
    lead(3, 2.8);
    S.cards.push(
      dot([EL[0], EL[1]], 3.1, 0.5, "dim"),
      dot([EL[1], EL[0]], 3.65, 0.45),
      dot([EL[0], [272, 140]], 3.1, 0.35, "dim", {
        col: [[3.42, "red"]],
        dies: 3.6,
      })
    );
    S.lamps[0].push([3.85, "amber"]);
    note(S, 0.6, "partition · 2 | 3", "amber");
    note(S, 1.6, "majority side · n4 stands", "amber");
    note(S, 2.8, "n4 leader · term 2", "green");
    note(S, 3.1, "n1 still leads term 1", "amber");
    note(S, 3.85, "1 of 2 acks · n1 can't commit", "red");
    return done();
  }
  S.lamps[2] = [[0, "red"]];
  if (f) {
    S.period = 5.6;
    stand(0, 0.3, 1.0);
    stand(3, 0.35, 1.05);
    S.term.push([1.0, "term 2", "ink"]);
    ask(0, [1], 1.1);
    ask(3, [4], 1.15);
    vote(0, [1], 1.7);
    vote(3, [4], 1.75);
    S.rings.push([0, 1.0, 2.4, "red"], [3, 1.05, 2.4, "red"]);
    S.lamps[0].push([2.4, "off"]);
    S.lamps[3].push([2.4, "off"]);
    stand(3, 2.6, 3.2);
    S.term.push([3.2, "term 3", "ink"]);
    ask(3, [0, 1, 4], 3.3);
    vote(3, [0, 1, 4], 3.85);
    lead(3, 4.4);
    note(S, 0.3, "n3 down · two time out", "amber");
    note(S, 1.0, "n1 and n4 stand · term 2", "amber");
    note(S, 2.4, "2 votes each · no majority", "red");
    note(S, 2.6, "random timeout · n4 first", "amber");
    note(S, 4.4, "n4 leader · term 3", "green");
    return done();
  }
  stand(0, 0.3, 1.0);
  S.term.push([1.0, "term 2", "ink"]);
  ask(0, [1, 3, 4], 1.1);
  vote(0, [1, 3, 4], 1.75);
  lead(0, 2.35);
  S.cards.push(...[1, 3, 4].map((j) => dot([EL[0], EL[j]], 2.9, 0.5, "dim")));
  note(S, 0.3, "n3 down · n1 times out", "amber");
  note(S, 1.0, "n1 stands · term 2", "amber");
  note(S, 1.75, "votes · 4 of 5", "ink");
  note(S, 2.35, "n1 leader · term 2", "green");
  note(S, 2.9, "heartbeats hold it", "dim");
  return done();
}

export const leaderElectionMachine: MachinePartDef<LeaderElectionExtra> = {
  part: {
    name: "leader election",
    job: leaderElectionSpec.job,
    aka: "Raft \u00b7 Paxos \u00b7 bully \u00b7 lease leader",
  },
  family: "distributed systems",
  footprint: "L",
  bb: leaderElectionSpec.bb,
  status: leaderElectionSpec.status,
  scenarios: [
    leaderElectionStory(0),
    leaderElectionStory(1),
    leaderElectionStory(2),
  ],
  draw: (t, S) => (
    <>
      <Cut x1={160} y1={59} x2={497} y2={302} at={S.cut} t={t} />
      {EL.map(([x, y], i) => {
        const [lx, ly, align] = ELab[i];
        return (
          <g key={i}>
            <NodeLamp x={x} y={y} r={20} steps={S.lamps[i]} t={t} />
            <Halo x={x} y={y} r={20} steps={S.halo[i]} t={t} />
            <FadedText
              x={lx}
              y={ly}
              runs={[[`n${i + 1}`, 400, "dim"]]}
              size={18}
              align={align}
            />
          </g>
        );
      })}
      {S.rings.map(([i, a, b, c], j) => (
        <Ring
          key={j}
          x={EL[i][0]}
          y={EL[i][1]}
          t={t}
          from={a}
          to={b}
          result={c}
          r={29}
        />
      ))}
      <Readout steps={S.term} t={t} x={616} y={96} align="right" />
    </>
  ),
};

export { EL } from "./leaderElectionSpec";
