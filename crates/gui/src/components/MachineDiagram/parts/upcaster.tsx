/**
 * upcaster · reads old events as new (catalogue "upcaster"): two upcast holes
 * (1 → 2, 2 → 3) on the way to the handler. An event stored at a version no
 * upcaster covers bounces back. Ported from the gallery line for line.
 */
import { Hole, PartBox, Ring } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import type { StateRole } from "../palette";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

interface UpcasterExtra {
  /** `[x, from, to, result]` of each upcast hole's ring. */
  readonly rings: readonly (readonly [number, number, number, StateRole])[];
}

function upcasterStory(
  kind: "v2 → v3" | "no upcaster for v0" | "v1 → v2 → v3"
): PartScenario<UpcasterExtra> {
  const s = story(4.4);
  s.gates.push(gateV(170, Y), gateV(470, Y));
  const rings: [number, number, number, StateRole][] = [];
  if (kind === "no upcaster for v0") {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [215, Y],
            ],
            0.6,
            0.55,
          ],
          [
            [
              [215, Y],
              [24, Y],
            ],
            1.35,
            0.75,
          ],
        ],
        0.6,
        2.2,
        {
          col: [[1.22, "red"]],
          lean: [1.35],
          tags: [
            ["v0", 0.65, 1.0],
            ["unknown", 1.5, 1.95],
          ],
        }
      )
    );
    note(s, 0.6, "read · stored as v0", "ink");
    note(s, 1.25, "no upcaster for v0", "red");
    return { name: kind, still: 1.85, timeline: seal(s), extra: { rings } };
  }
  if (kind === "v1 → v2 → v3") {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [260, Y],
            ],
            0.6,
            0.55,
          ],
          [
            [
              [260, Y],
              [380, Y],
            ],
            1.7,
            0.4,
          ],
          [
            [
              [380, Y],
              [616, Y],
            ],
            2.65,
            0.55,
          ],
        ],
        0.6,
        3.3,
        {
          lean: [1.7, 2.65],
          tags: [
            ["v1", 0.65, 1.0],
            ["v2", 1.72, 2.05],
            ["v3", 2.75, 3.2],
          ],
        }
      )
    );
    rings.push([260, 1.2, 1.65, "green"], [380, 2.15, 2.6, "green"]);
    note(s, 0.6, "read · stored as v1", "ink");
    note(s, 1.2, "upcast 1 → 2", "amber");
    note(s, 2.15, "upcast 2 → 3", "amber");
    note(s, 2.65, "v3 to handler", "green");
    return { name: kind, still: 2.45, timeline: seal(s), extra: { rings } };
  }
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, Y],
            [380, Y],
          ],
          0.6,
          0.7,
        ],
        [
          [
            [380, Y],
            [616, Y],
          ],
          1.9,
          0.6,
        ],
      ],
      0.6,
      2.6,
      {
        lean: [1.9],
        tags: [
          ["v2", 0.65, 1.1],
          ["v3", 2.0, 2.5],
        ],
      }
    )
  );
  rings.push([380, 1.35, 1.85, "green"]);
  note(s, 0.6, "read · stored as v2", "ink");
  note(s, 1.35, "upcast 2 → 3", "amber");
  note(s, 1.9, "v3 to handler", "green");
  return { name: kind, still: 1.6, timeline: seal(s), extra: { rings } };
}

export const upcasterMachine: MachinePartDef<UpcasterExtra> = {
  part: {
    name: "upcaster",
    job: "reads old events as new",
    aka: "event migration · versioned reader · adapter",
  },
  family: "event sourcing",
  footprint: "M",
  bb: [170, 120, 300, 160],
  status: { x: 320, y: 312 },
  scenarios: [
    upcasterStory("v2 → v3"),
    upcasterStory("no upcaster for v0"),
    upcasterStory("v1 → v2 → v3"),
  ],
  draw: (t, { rings }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [170, Y],
        ]}
      />
      <Rail
        points={[
          [470, Y],
          [616, Y],
        ]}
      />
      <PartBox x={170} y={120} w={300} h={160} />
      <SvgText
        x={320}
        y={100}
        runs={[["current version 3", 400, "dim"]]}
        size={18}
        align="center"
      />
      <Rail
        points={[
          [284, Y],
          [356, Y],
        ]}
      />
      {(
        [
          [260, "1 → 2"],
          [380, "2 → 3"],
        ] as const
      ).map(([x, label]) => (
        <g key={x}>
          <Hole x={x} y={Y} />
          <SvgText
            x={x}
            y={248}
            runs={[[label, 400, "dim"]]}
            size={18}
            align="center"
          />
        </g>
      ))}
      {rings.map(([x, from, to, result], i) => (
        <Ring key={i} x={x} y={Y} t={t} from={from} to={to} result={result} />
      ))}
    </>
  ),
};
