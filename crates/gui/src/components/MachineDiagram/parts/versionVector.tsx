import { Hole, PartBox, Ring } from "../fixtures";
import { Rail } from "../Rail";
import { card, gateV, note, seal, story, type StoryDraft } from "../timeline";
import { Tiles, tileSpec as TL } from "./distributedFixtures";
import { FadedText } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";
import {
  versionVectorSpec,
  type VersionVectorExtra,
} from "./versionVectorSpec";

export type { VersionVectorExtra } from "./versionVectorSpec";

/** Gallery reference scenarios; fixtures are evaluated only from frame time. */
const NAMES = ["ordered · replace", "concurrent · siblings", "merged"] as const;
const STILLS = [2.4, 2.4, 3.1];
function versionVectorStory(index: number): PartScenario<VersionVectorExtra> {
  const kind = NAMES[index],
    s = kind,
    f = index === 1;
  const S: StoryDraft & VersionVectorExtra = Object.assign(story(4.6), {
      rings: [],
      tl: [],
    } as VersionVectorExtra),
    mg = s === "merged",
    SX = 475;
  const done = (): PartScenario<VersionVectorExtra> => ({
    name: kind,
    still: STILLS[index],
    timeline: seal(S),
    extra: S,
  });
  S.gates.push(gateV(180, 200), gateV(320, 200));
  S.rings = [];
  if (mg) {
    S.period = 5.0;
    S.tl = [
      TL(SX, 165, "A2 B0", -1, [[-1e8, "amber"]], { w: 96, gone: 3.4 }),
      TL(SX, 235, "A1 B1", -1, [[-1e8, "amber"]], { w: 96, gone: 3.4 }),
      TL(
        SX,
        200,
        "A2 B2",
        3.45,
        [
          [3.45, "ink"],
          [3.8, "green"],
        ],
        { w: 96 }
      ),
    ];
    S.cards.push(
      card(
        28,
        "amber",
        [
          [
            [
              [400, 200],
              [24, 200],
            ],
            0.7,
            0.8,
          ],
        ],
        0.7,
        1.55,
        { tags: [["2 siblings", 0.75, 1.4]] }
      )
    );
    S.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, 200],
              [250, 200],
            ],
            1.9,
            0.55,
          ],
          [
            [
              [250, 200],
              [420, 200],
            ],
            2.9,
            0.45,
          ],
        ],
        1.9,
        3.4,
        { lean: [2.9], tags: [["A2 B2", 1.95, 2.4]] }
      )
    );
    S.rings.push([2.45, 2.85, "green"]);
    note(S, 0.7, "read · 2 siblings", "amber");
    note(S, 1.9, "client merges · writes A2 B2", "ink");
    note(S, 2.85, "dominates both", "dim");
    note(S, 3.45, "one value again", "green");
    return done();
  }
  if (f) {
    S.tl = [
      TL(SX, 200, "A2 B0", -1, [], { w: 96, gone: 2.0 }),
      TL(SX, 165, "A2 B0", 2.05, [[2.05, "amber"]], { w: 96 }),
      TL(SX, 235, "A1 B1", 2.15, [[2.15, "amber"]], { w: 96 }),
    ];
    S.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, 200],
              [250, 200],
            ],
            0.6,
            0.55,
          ],
          [
            [
              [250, 200],
              [420, 200],
            ],
            1.7,
            0.45,
          ],
        ],
        0.6,
        2.15,
        { lean: [1.7], tags: [["A1 B1", 0.65, 1.1]] }
      )
    );
    S.rings.push([1.2, 1.65, "amber"]);
    note(S, 0.6, "B writes A1 B1", "ink");
    note(S, 1.2, "vs stored A2 B0 · neither ≥", "amber");
    note(S, 2.15, "concurrent · keep both", "amber");
    return done();
  }
  S.tl = [
    TL(SX, 200, "A1 B0", -1, [], { w: 96, gone: 2.0 }),
    TL(
      SX,
      200,
      "A1 B1",
      2.1,
      [
        [2.1, "ink"],
        [2.6, "green"],
      ],
      { w: 96 }
    ),
  ];
  S.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, 200],
            [250, 200],
          ],
          0.6,
          0.55,
        ],
        [
          [
            [250, 200],
            [420, 200],
          ],
          1.7,
          0.45,
        ],
      ],
      0.6,
      2.15,
      { lean: [1.7], tags: [["A1 B1", 0.65, 1.1]] }
    )
  );
  S.rings.push([1.2, 1.65, "green"]);
  note(S, 0.6, "B writes · saw A1", "ink");
  note(S, 1.2, "A1 B1 ≥ A1 B0", "dim");
  note(S, 2.1, "newer · replace", "green");
  return done();
}

export const versionVectorMachine: MachinePartDef<VersionVectorExtra> = {
  part: {
    name: "version vector",
    job: versionVectorSpec.job,
    aka: "vector clock \u00b7 causality \u00b7 siblings",
  },
  family: "distributed systems",
  footprint: "L",
  bb: versionVectorSpec.bb,
  status: versionVectorSpec.status,
  scenarios: [
    versionVectorStory(0),
    versionVectorStory(1),
    versionVectorStory(2),
  ],
  draw: (t, S) => (
    <>
      <Rail
        points={[
          [24, 200],
          [180, 200],
        ]}
      />
      <Rail
        points={[
          [320, 200],
          [360, 200],
        ]}
      />
      <PartBox x={180} y={140} w={140} h={120} />
      <Hole x={250} y={200} r={24} />
      {S.rings.map(([a, b, c], i) => (
        <Ring key={i} x={250} y={200} from={a} to={b} result={c} t={t} r={24} />
      ))}
      <FadedText
        x={250}
        y={282}
        runs={[["compare", 400, "dim"]]}
        size={18}
        align="center"
      />
      <PartBox x={360} y={110} w={230} h={180} />
      <FadedText x={376} y={132} runs={[["stored", 400, "dim"]]} size={18} />
      <Tiles list={S.tl} t={t} />
    </>
  ),
};
