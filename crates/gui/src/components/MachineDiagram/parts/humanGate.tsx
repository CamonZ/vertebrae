/**
 * human gate · parks for a person's answer (catalogue "human gate"): a
 * parked slot with a waiting spinner; the answer artifact drops in from the
 * reviewer lane. Ported from the gallery line for line.
 */
import { Hole, PartBox, Spinner } from "../fixtures";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateH, gateV, note, seal, story } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

const Y = 210;
const SLOT = [300, Y] as const;

interface HumanGateExtra {
  /** The spinner turns between these times. */
  readonly wait: readonly [number, number];
}

function humanGateStory(
  kind: "answered" | "answer fails schema" | "stopped while waiting"
): PartScenario<HumanGateExtra> {
  const f = kind === "answer fails schema";
  const stop = kind === "stopped while waiting";
  const s = story(5.6);
  s.gates.push(gateV(200, Y), gateV(420, Y), gateH(400, 150));
  if (stop) {
    s.cards.push(
      card(28, "ink", [[[[24, Y], [...SLOT]], 0.6, 0.6]], 0.6, 3.6, {
        col: [[2.9, "edge"]],
        tags: [["run", 0.65, 1.0]],
      })
    );
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [140, Y],
            ],
            2.2,
            0.6,
          ],
        ],
        2.2,
        3.2,
        { hollow: true, tags: [["stop", 2.25, 2.7]] }
      )
    );
    note(s, 0.6, "run arrives", "ink");
    note(s, 1.2, "waiting · reviewer", "amber");
    note(s, 2.3, "stop-taskrun · stopping", "amber");
    note(s, 2.9, "stopped · gate closed", "dim");
    return {
      name: kind,
      still: 2.6,
      timeline: seal(s),
      extra: { wait: [1.2, 2.9] },
    };
  }
  // The answer artifact: a document card that drops in from the reviewer lane.
  s.cards.push(
    card(
      24,
      "ink",
      [
        [
          [
            [600, 96],
            [400, 96],
            [400, 176],
          ],
          2.4,
          0.8,
        ],
        ...(f
          ? [
              [
                [
                  [400, 176],
                  [400, 96],
                  [480, 96],
                ],
                3.6,
                0.7,
              ] as const,
            ]
          : []),
      ],
      2.4,
      f ? 4.35 : 3.45,
      {
        h: 32,
        col: [[3.2, f ? "red" : "green"]],
        lean: f ? [3.6] : [],
        tags: [
          ["answer.md", 2.45, 2.95],
          ...(f ? ([["missing decision", 3.9, 4.3]] as const) : []),
        ],
      }
    )
  );
  s.cards.push(
    card(
      28,
      "ink",
      [
        [[[24, Y], [...SLOT]], 0.6, 0.6],
        ...(f ? [] : [[[[...SLOT], [616, Y]], 3.5, 0.6] as const]),
      ],
      0.6,
      f ? 5.0 : 4.2,
      { col: [[3.3, f ? "ink" : "green"]], tags: [["run", 0.65, 1.0]] }
    )
  );
  note(s, 0.6, "run arrives", "ink");
  note(s, 1.2, "waiting · reviewer", "amber");
  note(s, 2.4, "answer.md attached", "ink");
  note(
    s,
    3.2,
    f ? "answer fails schema · gate still open" : "answer fits · run resumes",
    f ? "red" : "green"
  );
  if (f) note(s, 4.4, "waiting · reviewer", "amber");
  return {
    name: kind,
    still: f ? 4.2 : 2.9,
    timeline: seal(s),
    extra: { wait: [1.2, f ? 5.0 : 3.3] },
  };
}

export const humanGateMachine: MachinePartDef<HumanGateExtra> = {
  part: {
    name: "human gate",
    job: "parks for a person's answer",
    aka: "human_input · vtb gate set / submit · Resolve",
  },
  family: "vertebrae workflows",
  footprint: "M",
  bb: [200, 150, 220, 120],
  status: { x: 310, y: 302 },
  scenarios: [
    humanGateStory("answered"),
    humanGateStory("answer fails schema"),
    humanGateStory("stopped while waiting"),
  ],
  draw: (t, { wait }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [200, Y],
        ]}
      />
      <Rail
        points={[
          [420, Y],
          [616, Y],
        ]}
      />
      <Rail
        points={[
          [600, 96],
          [400, 96],
          [400, 150],
        ]}
      />
      <SvgText
        x={616}
        y={122}
        runs={[["reviewer", 400, "dim"]]}
        size={18}
        align="right"
      />
      <PartBox x={200} y={150} w={220} h={120} />
      <Hole x={SLOT[0]} y={Y} />
      <Spinner x={SLOT[0]} y={Y} t={t} from={wait[0]} to={wait[1]} />
      <SvgText
        x={300}
        y={252}
        runs={[["approve the plan?", 400, "dim"]]}
        size={18}
        align="center"
      />
    </>
  ),
};
