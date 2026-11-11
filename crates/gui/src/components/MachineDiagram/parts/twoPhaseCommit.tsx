import { Burst, Hole, Lamp, PartBox, Ring, Spinner } from "../fixtures";
import { lampAt, type LampStep } from "../geometry";
import type { StateRole } from "../palette";
import { Rail } from "../Rail";
import { StatusLine } from "../StatusLine";
import { SvgText } from "../SvgText";
import {
  card,
  dot,
  gateV,
  note,
  seal,
  statusAt,
  story,
  type StatusNote,
} from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

export interface TwoPhaseExtra {
  readonly lamps: readonly (readonly LampStep[])[];
  readonly rings: readonly (readonly [number, number, StateRole])[];
  readonly phase: readonly StatusNote[];
  readonly crash: number | null;
  readonly spin: readonly [number, number] | null;
}

const PARTICIPANTS = [110, 200, 290] as const;

function twoPhaseStory(
  kind: "commits" | "one votes no · abort" | "coordinator dies · blocked"
) {
  const s = story(4.6);
  const f = kind === "one votes no · abort";
  const blocked = kind === "coordinator dies · blocked";
  const lamps: LampStep[][] = PARTICIPANTS.map(() => [[0, "off"]]);
  const rings: [number, number, StateRole][] = [];
  const phase: [number, string, StateRole][] = [[0, "idle", "dim"]];
  let crash: number | null = null;
  let spin: [number, number] | null = null;
  const out = (y: number): [number, number][] => [
    [210, 200],
    [330, 200],
    [330, y],
    [420, y],
  ];
  const back = (y: number) => out(y).slice().reverse();
  s.gates.push(gateV(70, 200));
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, 200],
            [115, 200],
          ],
          0.6,
          0.5,
        ],
      ],
      0.6,
      1.2,
      { tags: [["txn 9", 0.65, 1.05]] }
    )
  );
  phase.push([1.2, "prepare", "amber"]);
  PARTICIPANTS.forEach((y, i) => {
    s.cards.push(dot(out(y), 1.2, 0.55));
    const no = f && i === 2;
    lamps[i].push([1.75, no ? "red" : "amber"]);
    s.cards.push(dot(back(y), 1.95, 0.55, no ? "red" : "ink"));
  });
  const done = (still: number): PartScenario<TwoPhaseExtra> => ({
    name: kind,
    still,
    timeline: seal(s),
    extra: { lamps, rings, phase, crash, spin },
  });
  if (blocked) {
    s.period = 5.0;
    crash = 2.5;
    rings.push([1.2, 2.5, "red"]);
    spin = [2.8, s.period - 0.3];
    phase.push([2.5, "?", "red"]);
    note(s, 0.6, "begin txn 9", "ink");
    note(s, 1.75, "3 prepared · locks held", "amber");
    note(s, 2.5, "coordinator crashed", "red");
    note(s, 3.1, "can't decide alone", "amber");
    note(s, 3.8, "blocked · locks held", "red");
    return done(4.0);
  }
  rings.push([1.2, 2.55, f ? "red" : "green"]);
  phase.push([2.65, f ? "abort" : "commit", f ? "red" : "green"]);
  if (f) {
    [110, 200].forEach((y, i) => {
      s.cards.push(dot(out(y), 2.7, 0.55, "red"));
      lamps[i].push([3.3, "off"]);
    });
    lamps[2].push([3.3, "off"]);
    s.cards.push(
      card(
        28,
        "red",
        [
          [
            [
              [115, 200],
              [24, 200],
            ],
            3.4,
            0.5,
          ],
        ],
        3.4,
        4.0,
        { tags: [["aborted", 3.45, 3.9]] }
      )
    );
    note(s, 0.6, "begin txn 9", "ink");
    note(s, 1.75, "p3 can't prepare", "red");
    note(s, 2.55, "one no · abort all", "red");
    note(s, 3.3, "rolled back · locks freed", "dim");
    return done(2.8);
  }
  PARTICIPANTS.forEach((y, i) => {
    s.cards.push(dot(out(y), 2.7, 0.55, "green"));
    lamps[i].push([3.3, "green"]);
  });
  s.cards.push(
    card(
      28,
      "green",
      [
        [
          [
            [115, 200],
            [24, 200],
          ],
          3.4,
          0.5,
        ],
      ],
      3.4,
      4.0,
      { tags: [["committed", 3.45, 3.9]] }
    )
  );
  note(s, 0.6, "begin txn 9", "ink");
  note(s, 1.75, "3 prepared · locks held", "amber");
  note(s, 2.55, "3 yes · commit", "green");
  note(s, 3.3, "all committed", "green");
  return done(2.0);
}

export const twoPhaseCommitMachine: MachinePartDef<TwoPhaseExtra> = {
  part: {
    name: "two-phase commit",
    job: "all commit or none do",
    aka: "2PC · XA · atomic commit",
  },
  family: "distributed systems",
  footprint: "L",
  bb: [70, 84, 500, 232],
  status: { x: 320, y: 346 },
  scenarios: [
    twoPhaseStory("commits"),
    twoPhaseStory("one votes no · abort"),
    twoPhaseStory("coordinator dies · blocked"),
  ],
  draw: (t, { lamps, rings, phase, crash, spin }) => (
    <>
      <Rail
        points={[
          [24, 200],
          [70, 200],
        ]}
      />
      {PARTICIPANTS.map((y) => (
        <Rail
          key={y}
          points={[
            [210, 200],
            [330, 200],
            [330, y],
            [420, y],
          ]}
        />
      ))}
      <PartBox
        x={70}
        y={150}
        w={140}
        h={100}
        dashed={crash != null && t >= crash}
      />
      <Hole x={140} y={200} r={22} />
      {rings.map(([a, b, c], i) => (
        <Ring key={i} x={140} y={200} t={t} from={a} to={b} result={c} r={22} />
      ))}
      {crash != null && (
        <Burst x={140} y={200} t={t} at={crash} role="red" r0={22} r1={100} />
      )}
      <StatusLine status={statusAt(phase, t)} x={140} y={272} size={18} />
      {PARTICIPANTS.map((y, i) => {
        const [role, k] = lampAt(lamps[i], t);
        return (
          <g key={y}>
            <PartBox x={420} y={y - 26} w={150} h={52} r={12} />
            <Lamp x={444} y={y} r={9} role={role} k={k} />
            <SvgText
              x={474}
              y={y}
              runs={[[`p${i + 1}`, 400, "dim"]]}
              size={18}
            />
            {spin && (
              <Spinner x={444} y={y} t={t} from={spin[0]} to={spin[1]} r={15} />
            )}
          </g>
        );
      })}
    </>
  ),
};
