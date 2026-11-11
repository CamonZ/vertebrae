/**
 * structured step · asks typed questions (catalogue "structured step"): an
 * answer hole with one lamp per question, then a schema check frame. Ported
 * from the gallery line for line.
 */
import { Hole, Lamp, PartBox, Spinner } from "../fixtures";
import { lampAt, type LampStep } from "../geometry";
import { RAIL_Y as Y } from "../MachinePart";
import type { CardRole } from "../palette";
import { Rail } from "../Rail";
import { card, gateV, note, seal, story } from "../timeline";
import { CheckFrame } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

interface StructuredExtra {
  /** The spinner turns between these times. */
  readonly wait: readonly [number, number];
  /** Schema check flashes `[at, outcome]`. */
  readonly chk: readonly (readonly [number, CardRole])[];
  /** One lamp timeline per question. */
  readonly lamps: readonly (readonly LampStep[])[];
}

function structuredStory(
  kind: "answered" | "answer rejected"
): PartScenario<StructuredExtra> {
  const f = kind === "answer rejected";
  const s = story(4.8);
  s.gates.push(gateV(180, Y), gateV(460, Y));
  const lamps: LampStep[][] = [
    [
      [0, "off"],
      [1.45, "green"],
    ],
    [
      [0, "off"],
      [1.8, "green"],
    ],
    [
      [0, "off"],
      [2.15, f ? "amber" : "green"],
    ],
  ];
  s.cards.push(
    card(
      36,
      "ink",
      [
        [
          [
            [24, Y],
            [270, Y],
          ],
          0.6,
          0.6,
        ],
        [
          [
            [270, Y],
            [402, Y],
          ],
          2.45,
          0.4,
        ],
        ...(f
          ? []
          : [
              [
                [
                  [402, Y],
                  [616, Y],
                ],
                3.05,
                0.6,
              ] as const,
            ]),
      ],
      0.6,
      f ? 4.0 : 3.7,
      {
        col: [
          [2.45, "ink"],
          [2.85, f ? "red" : "green"],
        ],
        tags: [
          ["state + 3 qs", 0.65, 1.05],
          [f ? "q3: maybe" : "answers", 2.95, 3.6, f ? 32 : -22],
        ],
      }
    )
  );
  note(s, 0.6, "state + questions in", "ink");
  note(s, 1.2, "asking · typesafe", "dim");
  note(s, 1.45, "1 of 3 answered", "amber");
  note(s, 2.15, "3 of 3 answered", "ink");
  note(
    s,
    2.85,
    f ? "q3 not in its enum · step failed" : "answers fit · step done",
    f ? "red" : "green"
  );
  return {
    name: kind,
    still: f ? 3.2 : 2.95,
    timeline: seal(s),
    extra: { wait: [1.2, 2.3], chk: [[2.85, f ? "red" : "green"]], lamps },
  };
}

export const structuredStepMachine: MachinePartDef<StructuredExtra> = {
  part: {
    name: "structured step",
    job: "asks typed questions",
    aka: "structured_inference · typesafe · System One",
  },
  family: "vertebrae workflows",
  footprint: "M",
  bb: [180, 110, 280, 180],
  status: { x: 320, y: 322 },
  scenarios: [structuredStory("answered"), structuredStory("answer rejected")],
  draw: (t, { wait, chk, lamps }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [180, Y],
        ]}
      />
      <Rail
        points={[
          [460, Y],
          [616, Y],
        ]}
      />
      <PartBox x={180} y={110} w={280} h={180} />
      <Hole x={270} y={Y} />
      <Spinner x={270} y={Y} t={t} from={wait[0]} to={wait[1]} />
      {[0, 1, 2].map((i) => {
        const [role, k] = lampAt(lamps[i], t);
        return (
          <Lamp key={i} x={230 + 40 * i} y={142} r={9} role={role} k={k} />
        );
      })}
      <CheckFrame x={402} y={Y} t={t} flashes={chk} />
    </>
  ),
};
