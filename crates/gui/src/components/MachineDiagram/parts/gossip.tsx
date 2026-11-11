import { PartBox } from "../fixtures";
import type { LampStep } from "../geometry";
import { pop } from "../motion";
import type { Point } from "../route";
import { card, dot, note, seal, story, type StoryDraft } from "../timeline";
import { Cut, NodeLamp } from "./distributedFixtures";
import { FadedText } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

/** Gallery reference scenarios; fixtures are evaluated only from frame time. */
export interface GossipExtra {
  lamps: LampStep[][];
  cut: number | null;
  extra: LampStep[] | null;
  xin: number;
}
export const GN: Point[] = [
  [190, 150],
  [320, 150],
  [450, 150],
  [190, 262],
  [320, 262],
  [450, 262],
];
const NAMES = ["spreads", "partitioned", "node joins"] as const;
const STILLS = [2.75, 3.6, 2.3];
function gossipStory(index: number): PartScenario<GossipExtra> {
  const kind = NAMES[index],
    s = kind,
    f = index === 1;
  const S: StoryDraft & GossipExtra = Object.assign(story(4.6), {
      lamps: [],
      cut: null,
      extra: null,
      xin: 0,
    } as GossipExtra),
    join = s === "node joins";
  const done = (): PartScenario<GossipExtra> => ({
    name: kind,
    still: STILLS[index],
    timeline: seal(S),
    extra: S,
  });
  S.gates.push();
  S.lamps = GN.map(() => [[0, "off"]]);
  S.cut = null;
  S.extra = null;
  const tell = (i: number, j: number, a: number, ok = true) => {
    if (ok) {
      S.cards.push(dot([GN[i], GN[j]], a, 0.5));
      S.lamps[j].push([a + 0.5, "ink"]);
    } else
      S.cards.push(
        dot(
          [
            GN[i],
            [
              385,
              GN[i][1] +
                ((GN[j][1] - GN[i][1]) * (385 - GN[i][0])) /
                  (GN[j][0] - GN[i][0]),
            ],
          ],
          a,
          0.35,
          "ink",
          { col: [[a + 0.33, "red"]], dies: a + 0.55 }
        )
      );
  };
  if (join) {
    S.period = 5.4;
    const X: Point = [565, 206];
    S.extra = [
      [0, "off"],
      [0.6, "amber"],
      [2.1, "green"],
    ];
    S.xin = 0.6;
    S.cards.push(dot([X, GN[2]], 0.9, 0.5));
    S.cards.push(
      card(14, "ink", [[[GN[2], X], 1.6, 0.5]], 1.6, 2.15, {
        dot: true,
        tags: [["6 members", 1.6, 2.1, -22]],
      })
    );
    S.lamps[2].push([1.4, "ink"]);
    tell(2, 1, 2.4);
    tell(2, 5, 2.45);
    tell(1, 0, 3.0);
    tell(5, 4, 3.05);
    tell(0, 3, 3.6);
    S.lamps.forEach((L) => L.push([4.3, "green"]));
    note(S, 0.6, "n7 joins via seed n3", "amber");
    note(S, 2.1, "n7 has the member list", "green");
    note(S, 2.4, '"n7 joined" spreads', "dim");
    note(S, 4.3, "7 of 7 know", "green");
    return done();
  }
  S.lamps[0].push([0.6, "ink"]);
  tell(0, 4, 1.0);
  if (f) {
    S.period = 4.8;
    S.cut = 0.6;
    tell(0, 1, 1.8);
    tell(4, 5, 1.85, false);
    tell(1, 2, 2.6, false);
    tell(4, 3, 2.65);
    [0, 1, 3, 4].forEach((i) => S.lamps[i].push([3.4, "green"]));
    [2, 5].forEach((i) => S.lamps[i].push([3.4, "red"]));
    note(S, 0.6, "n1 has news · partition", "amber");
    note(S, 1.5, "round 1 · 2 know", "dim");
    note(S, 2.35, "round 2 · 3 know", "dim");
    note(S, 3.4, "4 of 6 know · 2 cut off", "red");
    return done();
  }
  tell(0, 1, 1.8);
  tell(4, 5, 1.85);
  tell(1, 3, 2.6);
  tell(5, 2, 2.65);
  S.lamps.forEach((L) => L.push([3.4, "green"]));
  note(S, 0.6, "n1 has news", "ink");
  note(S, 1.5, "round 1 · 2 know", "dim");
  note(S, 2.35, "round 2 · 4 know", "dim");
  note(S, 3.15, "round 3 · 6 know", "dim");
  note(S, 3.4, "everyone knows · 3 rounds", "green");
  return done();
}
export const gossipMachine: MachinePartDef<GossipExtra> = {
  part: {
    name: "gossip",
    job: "spreads news peer to peer",
    aka: "epidemic broadcast \u00b7 membership \u00b7 SWIM",
  },
  family: "distributed systems",
  footprint: "L",
  bb: [160, 120, 320, 170],
  status: { x: 320, y: 336 },
  scenarios: [gossipStory(0), gossipStory(1), gossipStory(2)],
  draw: (t, S) => (
    <>
      <PartBox x={160} y={120} w={320} h={170} />
      <Cut x1={385} y1={96} x2={385} y2={312} at={S.cut} t={t} />
      {GN.map(([x, y], i) => (
        <NodeLamp key={i} x={x} y={y} r={20} steps={S.lamps[i]} t={t} />
      ))}
      {S.extra && t >= S.xin && (
        <>
          <g opacity={Math.min(1, pop(t - S.xin))}>
            <PartBox x={530} y={171} w={70} h={70} r={12} dashed />
          </g>
          <NodeLamp x={565} y={206} r={20} steps={S.extra} t={t} />
          <FadedText
            x={565}
            y={262}
            runs={[["n7", 400, "dim"]]}
            size={18}
            align="center"
            opacity={Math.min(1, pop(t - S.xin))}
          />
        </>
      )}
    </>
  ),
};
