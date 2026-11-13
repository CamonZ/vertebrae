import { Hole, PartBox, Ring } from "../fixtures";
import { Rail } from "../Rail";
import type { Point } from "../route";
import {
  card,
  dot,
  gateV,
  note,
  seal,
  story,
  type StoryDraft,
} from "../timeline";
import { NodeLamp, Readout } from "./distributedFixtures";
import { quorumSpec, type QuorumExtra } from "./quorumSpec";
import type { MachinePartDef, PartScenario } from "./types";

export type { QuorumExtra } from "./quorumSpec";

/** Gallery reference scenarios; fixtures are evaluated only from frame time. */
const NAMES = ["2 of 3 ack", "1 of 3 · no quorum", "read repair"] as const;
const STILLS = [2.7, 3.6, 3.2];
function quorumStory(index: number): PartScenario<QuorumExtra> {
  const kind = NAMES[index],
    s = kind,
    f = index === 1;
  const S: StoryDraft & QuorumExtra = Object.assign(story(4.6), {
      rings: [],
      dn: [],
      ver: [],
      lamps: [],
      ak: [],
    } as QuorumExtra),
    rep = s === "read repair",
    YS: number[] = [110, 200, 290];
  const done = (): PartScenario<QuorumExtra> => ({
    name: kind,
    still: STILLS[index],
    timeline: seal(S),
    extra: S,
  });
  S.gates.push(gateV(90, 200));
  S.rings = [];
  S.dn = [false, f, f];
  S.ver = YS.map((_, i) => [
    [0, `r${i + 1} · v${rep && i === 1 ? 7 : 7}`, "ink"],
  ]);
  S.lamps = YS.map((_, i) => [[0, f && i > 0 ? "red" : "green"]]);
  S.ak = [[0, "acks 0 / 2", "dim"]];
  const out = (y: number): Point[] => [
      [240, 200],
      [330, 200],
      [330, y],
      [430, y],
    ],
    back = (y: number) => out(y).slice().reverse();
  if (rep) {
    S.ver = YS.map((_, i) => [[0, `r${i + 1} · v${i === 1 ? 7 : 8}`, "ink"]]);
    S.ak = [[0, "replies 0 / 3", "dim"]];
    S.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, 200],
              [140, 200],
            ],
            0.6,
            0.5,
          ],
        ],
        0.6,
        1.2,
        { tags: [["read", 0.65, 1.05]] }
      )
    );
    YS.forEach((y, i) => {
      S.cards.push(dot(out(y), 1.2, 0.55));
      S.cards.push(
        dot(back(y), 1.9 + 0.08 * i, 0.55, i === 1 ? "amber" : "ink")
      );
      S.ak.push([2.5 + 0.08 * i, `replies ${i + 1} / 3`, "ink"]);
    });
    S.rings.push([1.2, 2.7, "green"]);
    S.cards.push(
      card(
        28,
        "green",
        [
          [
            [
              [140, 200],
              [24, 200],
            ],
            2.8,
            0.5,
          ],
        ],
        2.8,
        3.4,
        { tags: [["v8", 2.85, 3.3]] }
      )
    );
    S.cards.push(dot(out(200), 3.0, 0.6, "amber"));
    S.ver[1].push([3.65, "r2 · v8", "green"]);
    S.lamps[1].push([3.0, "amber"], [3.65, "green"]);
    note(S, 0.6, "read · ask all 3", "ink");
    note(S, 2.6, "v8 · v7 · v8", "dim");
    note(S, 2.8, "newest wins · v8", "green");
    note(S, 3.0, "repair r2", "amber");
    note(S, 3.65, "3 of 3 at v8", "green");
    return done();
  }
  S.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, 200],
            [140, 200],
          ],
          0.6,
          0.5,
        ],
      ],
      0.6,
      1.2,
      { tags: [["write v8", 0.65, 1.05]] }
    )
  );
  if (f) {
    S.period = 4.8;
    S.cards.push(dot(out(110), 1.2, 0.55));
    S.ver[0].push([1.8, "r1 · v8", "ink"]);
    S.cards.push(dot(back(110), 1.9, 0.55));
    S.ak.push([2.45, "acks 1 / 2", "amber"]);
    [200, 290].forEach((y) =>
      S.cards.push(
        dot(out(y), 1.2, 0.55, "ink", { col: [[1.7, "red"]], dies: 1.95 })
      )
    );
    S.rings.push([1.2, 3.2, "red"]);
    S.cards.push(
      card(
        28,
        "red",
        [
          [
            [
              [140, 200],
              [24, 200],
            ],
            3.3,
            0.5,
          ],
        ],
        3.3,
        3.9,
        { tags: [["failed", 3.35, 3.8]] }
      )
    );
    note(S, 0.6, "write · need 2 of 3", "ink");
    note(S, 1.2, "sent to 3", "dim");
    note(S, 2.45, "1 ack · waiting", "amber");
    note(S, 3.2, "no quorum · write fails", "red");
    return done();
  }
  S.cards.push(dot(out(110), 1.2, 0.55), dot(out(200), 1.25, 0.55));
  S.ver[0].push([1.8, "r1 · v8", "ink"]);
  S.ver[1].push([1.85, "r2 · v8", "ink"]);
  S.cards.push(
    card(
      14,
      "amber",
      [
        [
          out(290)
            .slice(0, 3)
            .concat([[330, 270]]),
          1.3,
          0.4,
        ],
        [
          [
            [330, 270],
            [330, 290],
            [430, 290],
          ],
          3.0,
          0.4,
        ],
      ],
      1.3,
      3.45,
      { dot: true }
    )
  );
  S.ver[2].push([3.45, "r3 · v8", "ink"]);
  S.lamps[2].push([1.75, "amber"], [3.45, "green"]);
  S.cards.push(dot(back(110), 1.9, 0.55), dot(back(200), 2.0, 0.55));
  S.ak.push([2.45, "acks 1 / 2", "amber"], [2.55, "acks 2 / 2", "green"]);
  S.rings.push([1.2, 2.55, "green"]);
  S.cards.push(
    card(
      28,
      "green",
      [
        [
          [
            [140, 200],
            [24, 200],
          ],
          2.7,
          0.5,
        ],
      ],
      2.7,
      3.3,
      { tags: [["ok", 2.75, 3.2]] }
    )
  );
  note(S, 0.6, "write · need 2 of 3", "ink");
  note(S, 1.2, "sent to 3", "dim");
  note(S, 2.55, "2 acks · quorum · ok", "green");
  note(S, 3.45, "r3 catches up", "dim");
  return done();
}

export const quorumMachine: MachinePartDef<QuorumExtra> = {
  part: {
    name: "quorum",
    job: quorumSpec.job,
    aka: "W + R > N \u00b7 majority write \u00b7 read repair",
  },
  family: "distributed systems",
  footprint: "L",
  bb: quorumSpec.bb,
  status: quorumSpec.status,
  scenarios: [quorumStory(0), quorumStory(1), quorumStory(2)],
  draw: (t, S) => (
    <>
      <Rail
        points={[
          [24, 200],
          [90, 200],
        ]}
      />
      {[110, 200, 290].map((y) => (
        <Rail
          key={y}
          points={[
            [240, 200],
            [330, 200],
            [330, y],
            [430, y],
          ]}
        />
      ))}
      <PartBox x={90} y={150} w={150} h={100} />
      <Hole x={165} y={200} r={22} />
      {S.rings.map(([a, b, c], i) => (
        <Ring key={i} x={165} y={200} t={t} from={a} to={b} result={c} r={22} />
      ))}
      <Readout steps={S.ak} t={t} x={165} y={272} align="center" />
      {[110, 200, 290].map((y, i) => (
        <g key={y}>
          <PartBox x={430} y={y - 26} w={140} h={52} r={12} dashed={S.dn[i]} />
          <NodeLamp x={452} y={y} r={8} steps={S.lamps[i]} t={t} />
          <Readout steps={S.ver[i]} t={t} x={470} y={y} />
        </g>
      ))}
    </>
  ),
};
