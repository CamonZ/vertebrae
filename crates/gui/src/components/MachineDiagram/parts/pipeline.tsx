/**
 * pipeline · ordered stages (catalogue "pipeline"): divided stages with a
 * slot and a lamp each; the card visits them in order and each lamp lights.
 * Ported from the gallery line for line.
 */
import { Hole, Lamp, PartBox, Ring } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { pop } from "../motion";
import type { CardRole } from "../palette";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story } from "../timeline";
import { Strokes } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

type Step = readonly [number, CardRole];

interface PipelineExtra {
  readonly stages?: readonly string[];
  /** Per stage: when its lamp lights and in which role. */
  readonly lamps: readonly Step[];
  /** `[x, from, to, result]` slot rings. */
  readonly rings: readonly (readonly [number, number, number, CardRole])[];
}

const STAGES = ["build", "test", "ship"] as const;
const stageX = (i: number) => 160 + 160 * i;

function pipelineStory(
  kind: "all pass" | "fails at test" | "cancelled"
): PartScenario<PipelineExtra> {
  const s = story(5.2);
  s.gates.push(gateV(80, Y), gateV(240, Y), gateV(400, Y), gateV(560, Y));
  const done = (
    lamps: Step[],
    rings: PipelineExtra["rings"],
    still: number
  ): PartScenario<PipelineExtra> => ({
    name: kind,
    still,
    timeline: seal(s),
    extra: { lamps, rings },
  });
  if (kind === "cancelled") {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [160, Y],
            ],
            0.6,
            0.5,
          ],
          [
            [
              [160, Y],
              [320, Y],
            ],
            1.6,
            0.45,
          ],
        ],
        0.6,
        2.6,
        { col: [[2.3, "edge"]], lean: [1.6] }
      )
    );
    s.cards.push(
      card(
        18,
        "ink",
        [
          [
            [
              [320, 52],
              [320, 110],
            ],
            1.8,
            0.45,
          ],
        ],
        1.8,
        2.3,
        { tags: [["cancel", 1.85, 2.3, 0]] }
      )
    );
    note(s, 0.6, "stage 1 · build", "dim");
    note(s, 1.65, "stage 2 · test", "dim");
    note(s, 2.3, "cancelled at test", "ink");
    return done(
      [
        [1.6, "green"],
        [2.3, "edge"],
      ],
      [
        [160, 1.1, 1.6, "green"],
        [320, 2.05, 2.3, "edge"],
      ],
      2.6
    );
  }
  const f = kind === "fails at test";
  let lamps: Step[];
  let rings: PipelineExtra["rings"];
  if (!f) {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [160, Y],
            ],
            0.6,
            0.5,
          ],
          [
            [
              [160, Y],
              [320, Y],
            ],
            1.6,
            0.45,
          ],
          [
            [
              [320, Y],
              [480, Y],
            ],
            2.55,
            0.45,
          ],
          [
            [
              [480, Y],
              [616, Y],
            ],
            3.5,
            0.5,
          ],
        ],
        0.6,
        4.05,
        { lean: [1.6, 2.55, 3.5] }
      )
    );
    lamps = [
      [1.6, "green"],
      [2.55, "green"],
      [3.5, "green"],
    ];
    rings = [
      [160, 1.1, 1.6, "green"],
      [320, 2.05, 2.55, "green"],
      [480, 3.0, 3.5, "green"],
    ];
  } else {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [160, Y],
            ],
            0.6,
            0.5,
          ],
          [
            [
              [160, Y],
              [320, Y],
            ],
            1.6,
            0.45,
          ],
        ],
        0.6,
        2.9,
        { col: [[2.43, "red"]], lean: [1.6] }
      )
    );
    lamps = [
      [1.6, "green"],
      [2.55, "red"],
    ];
    rings = [
      [160, 1.1, 1.6, "green"],
      [320, 2.05, 2.55, "red"],
    ];
  }
  note(s, 0.6, "stage 1 · build", "dim");
  note(s, 1.65, "stage 2 · test", "dim");
  if (f) note(s, 2.55, "failed at test", "red");
  else {
    note(s, 2.6, "stage 3 · ship", "dim");
    note(s, 3.5, "all stages passed", "green");
  }
  return done(lamps, rings, 2.2);
}

export const pipelineMachine: MachinePartDef<PipelineExtra> = {
  part: {
    name: "pipeline",
    job: "ordered stages",
    aka: "CI job · ETL · middleware chain · workflow",
  },
  family: "compute",
  footprint: "L",
  bb: [80, 125, 480, 150],
  status: { x: 320, y: 310 },
  scenarios: [
    pipelineStory("all pass"),
    pipelineStory("fails at test"),
    pipelineStory("cancelled"),
  ],
  draw: (t, { lamps, rings, stages = STAGES }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [80, Y],
        ]}
      />
      <Rail
        points={[
          [560, Y],
          [616, Y],
        ]}
      />
      <PartBox x={80} y={125} w={480} h={150} />
      <Strokes
        w={2}
        lines={[240, 400].flatMap((x) => [
          [
            [x, 125],
            [x, Y - 26],
          ],
          [
            [x, Y + 26],
            [x, 275],
          ],
        ])}
      />
      {stages.map((name, i) => {
        const x = stageX(i);
        const l = lamps[i];
        return (
          <g key={name}>
            <Hole x={x} y={Y} />
            <SvgText
              x={x}
              y={252}
              runs={[[name, 400, "dim"]]}
              size={18}
              align="center"
            />
            <Lamp
              x={x}
              y={146}
              r={7}
              role={l && t >= l[0] ? l[1] : null}
              k={l ? pop(t - l[0]) : 0}
            />
          </g>
        );
      })}
      {rings.map(([x, from, to, result], i) => (
        <Ring key={i} x={x} y={Y} t={t} from={from} to={to} result={result} />
      ))}
    </>
  ),
};
