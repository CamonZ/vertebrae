import { Burst, PartBox } from "../fixtures";
import type { LampStep } from "../geometry";
import { Rail } from "../Rail";
import type { Point } from "../route";
import {
  card,
  dot,
  gateV,
  note,
  seal,
  story,
  type StatusNote,
  type StoryDraft,
} from "../timeline";
import { NodeLamp, Readout } from "./distributedFixtures";
import type { MachinePartDef, PartScenario } from "./types";

/** Gallery reference scenarios; fixtures are evaluated only from frame time. */
export interface ReplicationExtra {
  fo: boolean;
  down: number | null;
  ver: StatusNote[][];
  role: StatusNote[][];
  lamps: LampStep[][];
}
const NAMES = [
  "replicated",
  "follower lags · stale read",
  "leader fails · failover",
] as const;
const STILLS = [2.3, 2.95, 2.3];
function replicationStory(index: number): PartScenario<ReplicationExtra> {
  const kind = NAMES[index],
    s = kind,
    f = index === 1;
  const S: StoryDraft & ReplicationExtra = Object.assign(story(4.6), {
      fo: false,
      down: null,
      ver: [],
      role: [],
      lamps: [],
    } as ReplicationExtra),
    fo = s === "leader fails · failover";
  const done = (): PartScenario<ReplicationExtra> => ({
    name: kind,
    still: STILLS[index],
    timeline: seal(S),
    extra: S,
  });
  S.gates.push(gateV(80, 200));
  S.fo = fo;
  S.down = null;
  S.ver = [[[0, "v7", "ink"]], [[0, "v7", "ink"]], [[0, "v7", "ink"]]];
  S.role = [
    [[0, "leader", "dim"]],
    [[0, "follower", "dim"]],
    [[0, "follower", "dim"]],
  ];
  S.lamps = [[[0, "green"]], [[0, "green"]], [[0, "green"]]];
  const R1: Point[] = [
      [240, 185],
      [330, 185],
      [330, 140],
      [430, 140],
    ],
    R2: Point[] = [
      [240, 215],
      [330, 215],
      [330, 260],
      [430, 260],
    ];
  const write = (a: number) => {
    S.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, 200],
              [118, 200],
            ],
            a,
            0.5,
          ],
        ],
        a,
        a + 0.6,
        { tags: [["write", a + 0.05, a + 0.45]] }
      )
    );
  };
  if (fo) {
    S.period = 5.0;
    S.down = 0.6;
    S.lamps[0].push([0.6, "red"]);
    S.role[0].push([0.6, "down", "red"]);
    S.lamps[1].push([1.1, "amber"]);
    S.lamps[2].push([1.1, "amber"]);
    S.lamps[1].push([2.1, "green"]);
    S.role[1].push([2.1, "leader", "ink"]);
    S.lamps[2].push([2.25, "green"]);
    S.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [616, 140],
              [566, 140],
            ],
            2.6,
            0.45,
          ],
        ],
        2.6,
        3.15,
        { tags: [["write", 2.65, 3.05]] }
      )
    );
    S.ver[1].push([3.1, "v8", "ink"]);
    S.cards.push(
      dot(
        [
          [580, 170],
          [602, 170],
          [602, 230],
          [580, 230],
        ],
        3.3,
        0.6
      )
    );
    S.ver[2].push([3.95, "v8", "ink"]);
    note(S, 0.6, "leader crashed", "red");
    note(S, 1.1, "no heartbeat · followers wait", "amber");
    note(S, 2.1, "f1 promoted · term 2", "green");
    note(S, 2.6, "writes go to f1", "ink");
    note(S, 3.95, "f2 follows f1 · v8", "green");
    return done();
  }
  write(0.6);
  S.ver[0].push([1.15, "v8", "ink"]);
  S.cards.push(dot(R1, 1.3, 0.6));
  S.ver[1].push([1.95, "v8", "ink"]);
  if (f) {
    S.cards.push(
      card(
        14,
        "amber",
        [
          [R2.slice(0, 3).concat([[330, 240]]), 1.4, 0.45],
          [
            [
              [330, 240],
              [330, 260],
              [430, 260],
            ],
            3.2,
            0.45,
          ],
        ],
        1.4,
        3.7,
        { dot: true }
      )
    );
    S.ver[2].push([3.7, "v8", "ink"]);
    S.lamps[2].push([1.9, "amber"], [3.7, "green"]);
    S.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [616, 260],
              [566, 260],
            ],
            2.0,
            0.45,
          ],
          [
            [
              [566, 260],
              [616, 260],
            ],
            2.6,
            0.45,
          ],
        ],
        2.0,
        3.4,
        {
          col: [[2.5, "red"]],
          lean: [2.6],
          tags: [
            ["read", 2.05, 2.45],
            ["v7", 2.65, 3.3],
          ],
        }
      )
    );
    note(S, 0.6, "write", "ink");
    note(S, 1.15, "leader at v8", "dim");
    note(S, 1.95, "f1 at v8 · f2 lags", "amber");
    note(S, 2.55, "read on f2 returns v7", "red");
    note(S, 3.7, "f2 caught up", "dim");
    return done();
  }
  S.cards.push(dot(R2, 1.4, 0.6));
  S.ver[2].push([2.05, "v8", "ink"]);
  S.cards.push(
    card(
      28,
      "green",
      [
        [
          [
            [118, 200],
            [24, 200],
          ],
          2.3,
          0.5,
        ],
      ],
      2.3,
      2.9,
      { tags: [["ack", 2.35, 2.8]] }
    )
  );
  note(S, 0.6, "write", "ink");
  note(S, 1.15, "leader at v8 · copying", "dim");
  note(S, 2.05, "2 of 2 followers at v8", "green");
  return done();
}
export const replicationMachine: MachinePartDef<ReplicationExtra> = {
  part: {
    name: "replication",
    job: "copies writes to followers",
    aka: "leader / follower \u00b7 primary / replica",
  },
  family: "distributed systems",
  footprint: "L",
  bb: [80, 95, 500, 210],
  status: { x: 320, y: 340 },
  scenarios: [replicationStory(0), replicationStory(1), replicationStory(2)],
  draw: (t, S) => (
    <>
      <Rail
        points={[
          [24, 200],
          [80, 200],
        ]}
      />
      <Rail
        points={[
          [240, 185],
          [330, 185],
          [330, 140],
          [430, 140],
        ]}
      />
      <Rail
        points={[
          [240, 215],
          [330, 215],
          [330, 260],
          [430, 260],
        ]}
      />
      <Rail
        points={[
          [580, 140],
          [616, 140],
        ]}
      />
      <Rail
        points={[
          [580, 260],
          [616, 260],
        ]}
      />
      {S.fo && (
        <Rail
          points={[
            [580, 170],
            [602, 170],
            [602, 230],
            [580, 230],
          ]}
        />
      )}
      <PartBox
        x={80}
        y={140}
        w={160}
        h={120}
        dashed={S.down != null && t >= S.down}
      />
      <PartBox x={430} y={95} w={150} h={90} r={12} />
      <PartBox x={430} y={215} w={150} h={90} r={12} />
      {S.down != null && (
        <Burst x={160} y={200} t={t} at={S.down} role="red" r0={30} r1={110} />
      )}
      {[
        [102, 162],
        [452, 120],
        [452, 240],
      ].map(([x, y], i) => (
        <NodeLamp key={i} x={x} y={y} r={8} steps={S.lamps[i]} t={t} />
      ))}
      {[
        [150, 170, 224],
        [468, 122, 158],
        [468, 242, 278],
      ].map(([x, y, vy], i) => (
        <g key={i}>
          <Readout steps={S.role[i]} t={t} x={x} y={y} />
          <Readout steps={S.ver[i]} t={t} x={x} y={vy} size={20} />
        </g>
      ))}
    </>
  ),
};
