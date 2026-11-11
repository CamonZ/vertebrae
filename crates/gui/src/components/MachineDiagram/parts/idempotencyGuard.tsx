/**
 * idempotency guard · applies each key once (catalogue "idempotency guard"): a
 * check hole, a row of seen keys and the effect box. A duplicate gets the
 * stored result; an expired key lets the effect run twice. Ported from the
 * gallery line for line.
 */
import { Bar, Hole, PartBox, Ring } from "../fixtures";
import { pop } from "../motion";
import type { StateRole } from "../palette";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story } from "../timeline";
import { TL, Tiles, type TileSpec } from "./eventTiles";
import type { MachinePartDef, PartScenario } from "./types";

interface IdempotencyExtra {
  readonly tl: readonly TileSpec[];
  /** Check-hole rings. */
  readonly rings: readonly (readonly [number, number, StateRole])[];
  /** Effect-box rings. */
  readonly erings: readonly (readonly [number, number, StateRole])[];
  /** Effects applied: `[time, role]`. */
  readonly fx: readonly (readonly [number, "ink" | "red"])[];
}

const Y = 220;
const HO = [270, Y] as const;
const FX = [550, Y] as const;

function idempotencyStory(
  kind:
    | "first then duplicate"
    | "key expired · applied twice"
    | "in flight · second waits"
): PartScenario<IdempotencyExtra> {
  const s = story(6.0);
  const wait = kind === "in flight · second waits";
  const f = kind === "key expired · applied twice";
  s.gates.push(gateV(200, Y), gateV(440, Y), gateV(500, Y));
  const rings: [number, number, StateRole][] = [];
  const erings: [number, number, StateRole][] = [];
  const fx: [number, "ink" | "red"][] = [];
  const tl = [
    TL(300, 160, "k3", -1, [], { w: 44 }),
    TL(350, 160, "k5", -1, [], { w: 44 }),
  ];
  const k7 = TL(
    400,
    160,
    "k7",
    1.5,
    [
      [1.5, "amber"],
      [wait ? 3.85 : 2.25, "green"],
    ],
    { w: 44 }
  );
  tl.push(k7);
  const aDone = wait ? 3.85 : 2.2;
  rings.push([1.2, 1.5, "green"]);
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, Y],
            [HO[0], HO[1]],
          ],
          0.6,
          0.55,
        ],
        [
          [
            [HO[0], HO[1]],
            [FX[0], FX[1]],
          ],
          1.55,
          0.55,
        ],
      ],
      0.6,
      aDone,
      { lean: [1.55], tags: [["k7", 0.65, 1.0]] }
    )
  );
  fx.push([aDone, "ink"]);
  let still = 2.5;
  if (wait) {
    erings.push([2.1, 3.8, "green"]);
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [HO[0], HO[1]],
            ],
            1.9,
            0.55,
          ],
          [
            [
              [HO[0], HO[1]],
              [24, Y],
            ],
            3.95,
            0.65,
          ],
        ],
        1.9,
        4.7,
        {
          col: [
            [2.75, "amber"],
            [3.85, "green"],
          ],
          lean: [3.95],
          tags: [
            ["k7", 1.95, 2.3],
            ["waiting", 2.8, 3.8],
            ["result", 4.05, 4.6],
          ],
        }
      )
    );
    rings.push([2.45, 2.75, "amber"]);
    note(s, 0.6, "k7 · first", "ink");
    note(s, 1.5, "new key · in flight", "amber");
    note(s, 2.75, "k7 again · waits", "amber");
    note(s, 3.85, "applied once", "green");
    note(s, 4.0, "second gets the result", "green");
    still = 3.2;
  } else if (f) {
    s.period = 6.2;
    k7.gone = 3.0;
    tl.push(
      TL(
        400,
        160,
        "k7",
        4.2,
        [
          [4.2, "amber"],
          [4.8, "red"],
        ],
        { w: 44 }
      )
    );
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [HO[0], HO[1]],
            ],
            3.3,
            0.55,
          ],
          [
            [
              [HO[0], HO[1]],
              [FX[0], FX[1]],
            ],
            4.25,
            0.55,
          ],
        ],
        3.3,
        4.85,
        {
          col: [[4.75, "red"]],
          lean: [4.25],
          tags: [["k7", 3.35, 3.7]],
        }
      )
    );
    rings.push([3.9, 4.2, "amber"]);
    fx.push([4.85, "red"]);
    note(s, 0.6, "k7 · first", "ink");
    note(s, 1.5, "new key · applying", "amber");
    note(s, 2.2, "applied", "green");
    note(s, 3.0, "k7 key expired", "dim");
    note(s, 3.9, "k7 looks new", "amber");
    note(s, 4.85, "applied twice", "red");
    still = 4.1;
  } else {
    k7.col.push([3.5, "ink"], [3.85, "green"]);
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [HO[0], HO[1]],
            ],
            2.9,
            0.55,
          ],
          [
            [
              [HO[0], HO[1]],
              [24, Y],
            ],
            3.9,
            0.65,
          ],
        ],
        2.9,
        4.6,
        {
          col: [[3.8, "green"]],
          lean: [3.9],
          tags: [
            ["k7", 2.95, 3.3],
            ["stored result", 4.0, 4.5],
          ],
        }
      )
    );
    rings.push([3.5, 3.8, "green"]);
    note(s, 0.6, "k7 · first", "ink");
    note(s, 1.5, "new key · applying", "amber");
    note(s, 2.2, "applied · result stored", "green");
    note(s, 2.9, "k7 again", "ink");
    note(s, 3.8, "duplicate · no second effect", "green");
  }
  return {
    name: kind,
    still,
    timeline: seal(s),
    extra: { tl, rings, erings, fx },
  };
}

export const idempotencyGuardMachine: MachinePartDef<IdempotencyExtra> = {
  part: {
    name: "idempotency guard",
    job: "applies each key once",
    aka: "dedupe · idempotency key · exactly-once effect",
  },
  family: "event sourcing",
  footprint: "M",
  bb: [200, 120, 240, 160],
  status: { x: 320, y: 320 },
  scenarios: [
    idempotencyStory("first then duplicate"),
    idempotencyStory("key expired · applied twice"),
    idempotencyStory("in flight · second waits"),
  ],
  draw: (t, { tl, rings, erings, fx }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [200, Y],
        ]}
      />
      <Rail
        points={[
          [440, Y],
          [500, Y],
        ]}
      />
      <PartBox x={200} y={120} w={240} h={160} />
      <PartBox x={500} y={170} w={100} h={100} r={12} />
      <SvgText
        x={550}
        y={290}
        runs={[["effect", 400, "dim"]]}
        size={18}
        align="center"
      />
      <Hole x={HO[0]} y={HO[1]} r={22} />
      {rings.map(([from, to, result], i) => (
        <Ring
          key={i}
          x={HO[0]}
          y={HO[1]}
          t={t}
          from={from}
          to={to}
          result={result}
          r={22}
        />
      ))}
      {erings.map(([from, to, result], i) => (
        <Ring
          key={i}
          x={FX[0]}
          y={FX[1]}
          t={t}
          from={from}
          to={to}
          result={result}
          r={22}
        />
      ))}
      <SvgText x={214} y={160} runs={[["seen", 400, "dim"]]} size={18} />
      <Tiles list={tl} t={t} />
      {fx.map(([a, role], i) =>
        t >= a ? (
          <Bar
            key={i}
            x={512}
            y={248 + 12 * i}
            w={76}
            role={role}
            k={pop(t - a)}
          />
        ) : null
      )}
    </>
  ),
};
