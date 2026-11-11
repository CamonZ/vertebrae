/**
 * saga · steps forward, undoes backward (catalogue "saga"): three step
 * stations with lamps and a dashed undo lane underneath. A failed step sends
 * the card back along the undo lane, releasing each earlier step. Ported from
 * the gallery line for line.
 */
import { Hole, Lamp, PartBox, Ring } from "../fixtures";
import { lampAt, type LampStep } from "../geometry";
import type { StateRole } from "../palette";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story, type LegInput } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

interface SagaExtra {
  /** `[x, y, from, to, result]` of each ring (step stations and undo holes). */
  readonly rings: readonly (readonly [
    number,
    number,
    number,
    number,
    StateRole,
  ])[];
  readonly lamps: readonly (readonly LampStep[])[];
}

const Y = 165;
const UNDO = 255;
const XS = [170, 320, 470] as const;
const STEP_T = [
  [1.15, 1.6],
  [2.15, 2.6],
  [3.15, 3.6],
] as const;
const STEPS = ["reserve", "charge", "ship"] as const;

function sagaStory(
  kind: "completes" | "compensates" | "no reply · deadline"
): PartScenario<SagaExtra> {
  const s = story(5.0);
  const late = kind === "no reply · deadline";
  const f = kind === "compensates";
  s.gates.push(gateV(70, Y), gateV(570, Y));
  const rings: [number, number, number, number, StateRole][] = [];
  const lamps: LampStep[][] = [[], [], []];
  const legs: LegInput[] = [
    [
      [
        [24, Y],
        [170, Y],
      ],
      0.6,
      0.5,
    ],
    [
      [
        [170, Y],
        [320, Y],
      ],
      1.65,
      0.45,
    ],
  ];
  const step = (
    i: number,
    res: StateRole,
    a: number = STEP_T[i][0],
    b: number = STEP_T[i][1]
  ) => {
    rings.push([XS[i], Y, a, b, res]);
    lamps[i].push([b, res]);
  };
  step(0, "green");
  if (late) {
    s.period = 6.0;
    step(1, "red", 2.15, 3.6);
    legs.push(
      [
        [
          [320, Y],
          [320, UNDO],
          [170, UNDO],
        ],
        3.7,
        0.7,
      ],
      [
        [
          [170, UNDO],
          [110, UNDO],
        ],
        4.95,
        0.4,
      ]
    );
    rings.push([170, UNDO, 4.45, 4.9, "green"]);
    lamps[0].push([4.9, "off"]);
    lamps[1].push([4.9, "off"]);
    s.cards.push(
      card(28, "ink", legs, 0.6, 5.4, {
        col: [[3.5, "red"]],
        tags: [
          ["order 7", 0.65, 1.0],
          ["release", 4.05, 4.5],
        ],
      })
    );
    note(s, 0.6, "OrderPlaced", "ink");
    note(s, 1.15, "reserve stock", "dim");
    note(s, 2.15, "charge · waiting for reply", "amber");
    note(s, 3.6, "no reply · deadline", "red");
    note(s, 4.9, "released · order cancelled", "red");
    return {
      name: kind,
      still: 3.0,
      timeline: seal(s),
      extra: { rings, lamps },
    };
  }
  step(1, "green");
  legs.push([
    [
      [320, Y],
      [470, Y],
    ],
    2.65,
    0.45,
  ]);
  if (!f) {
    step(2, "green");
    legs.push([
      [
        [470, Y],
        [616, Y],
      ],
      3.65,
      0.5,
    ]);
    s.cards.push(
      card(28, "ink", legs, 0.6, 4.3, {
        tags: [["order 7", 0.65, 1.0]],
      })
    );
    note(s, 0.6, "OrderPlaced", "ink");
    note(s, 1.15, "reserve stock", "dim");
    note(s, 2.15, "charge card", "dim");
    note(s, 3.15, "ship", "dim");
    note(s, 3.65, "saga complete", "green");
    return {
      name: kind,
      still: 3.9,
      timeline: seal(s),
      extra: { rings, lamps },
    };
  }
  s.period = 6.6;
  step(2, "red");
  legs.push(
    [
      [
        [470, Y],
        [470, UNDO],
        [320, UNDO],
      ],
      3.7,
      0.6,
    ],
    [
      [
        [320, UNDO],
        [170, UNDO],
      ],
      4.75,
      0.45,
    ],
    [
      [
        [170, UNDO],
        [110, UNDO],
      ],
      5.7,
      0.4,
    ]
  );
  rings.push([320, UNDO, 4.3, 4.7, "green"], [170, UNDO, 5.2, 5.6, "green"]);
  lamps[1].push([4.7, "off"]);
  lamps[0].push([5.6, "off"]);
  s.cards.push(
    card(28, "ink", legs, 0.6, 6.15, {
      col: [[3.5, "red"]],
      tags: [
        ["order 7", 0.65, 1.0],
        ["refund", 3.95, 4.3],
        ["release", 4.85, 5.2],
      ],
    })
  );
  note(s, 0.6, "OrderPlaced", "ink");
  note(s, 1.15, "reserve stock", "dim");
  note(s, 2.15, "charge card", "dim");
  note(s, 3.15, "ship", "dim");
  note(s, 3.6, "ship failed · undoing", "red");
  note(s, 4.7, "refunded", "amber");
  note(s, 5.6, "released · order cancelled", "red");
  return {
    name: kind,
    still: 3.9,
    timeline: seal(s),
    extra: { rings, lamps },
  };
}

export const sagaMachine: MachinePartDef<SagaExtra> = {
  part: {
    name: "saga",
    job: "steps forward, undoes backward",
    aka: "process manager · orchestrator · compensation",
  },
  family: "event sourcing",
  footprint: "L",
  bb: [70, 100, 500, 200],
  status: { x: 320, y: 332 },
  scenarios: [
    sagaStory("completes"),
    sagaStory("compensates"),
    sagaStory("no reply · deadline"),
  ],
  draw: (t, { rings, lamps }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [70, Y],
        ]}
      />
      <Rail
        points={[
          [570, Y],
          [616, Y],
        ]}
      />
      <PartBox x={70} y={100} w={500} h={200} />
      <Rail
        points={[
          [192, Y],
          [298, Y],
        ]}
      />
      <Rail
        points={[
          [342, Y],
          [448, Y],
        ]}
      />
      <Rail
        dashed
        dash="4 6"
        points={[
          [470, UNDO],
          [110, UNDO],
        ]}
      />
      <SvgText x={490} y={UNDO} runs={[["undo", 400, "dim"]]} size={18} />
      {STEPS.map((label, i) => {
        const x = XS[i];
        const [role, k] = lampAt(lamps[i], t);
        return (
          <g key={label}>
            <Hole x={x} y={Y} r={22} />
            <SvgText
              x={x}
              y={206}
              runs={[[label, 400, "dim"]]}
              size={18}
              align="center"
            />
            <Lamp x={x} y={124} r={7} role={role} k={k} />
          </g>
        );
      })}
      <Hole x={320} y={UNDO} r={18} />
      <Hole x={170} y={UNDO} r={18} />
      {rings.map(([x, y, from, to, result], i) => (
        <Ring
          key={i}
          x={x}
          y={y}
          t={t}
          from={from}
          to={to}
          result={result}
          r={y === Y ? 22 : 18}
        />
      ))}
    </>
  ),
};
