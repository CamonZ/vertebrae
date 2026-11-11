/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism component */
/**
 * store · keeps records (catalogue "store"): a bar stack; records spring in as
 * bars, a read lights one bar amber. Ported from the gallery line for line.
 */
import { Bar, PartBox } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { pop, windowed } from "../motion";
import type { StateRole } from "../palette";
import { Rail } from "../Rail";
import { card, gateV, note, seal, story } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

/** `[appearsAt, width, role]`; `appearsAt < 0` is a row that was already stored. */
type Row = readonly [number, number, "edge" | "ink" | "amber"];

interface StoreExtra {
  readonly rows: readonly Row[];
  /** A read sweeps every row (a miss) from this time. */
  readonly sweep: number | null;
  /** When the read of row 2 lights its bar. */
  readonly read: number;
}

const X = 254;

function storeStory(
  kind: "insert · read" | "unique conflict" | "not found"
): PartScenario<StoreExtra> {
  const f = kind === "unique conflict";
  const s = story(4.4);
  s.gates.push(gateV(230, Y), gateV(410, Y));
  const rows: Row[] = [
    [-1, 150, "edge"],
    [-1, 110, "ink"],
    [-1, 170, "ink"],
    [-1, 90, "edge"],
  ];
  if (!f) {
    s.cards.push(
      card(
        28,
        "amber",
        [
          [
            [
              [24, Y],
              [300, Y],
            ],
            0.6,
            0.6,
          ],
        ],
        0.6,
        1.25,
        { tags: [["insert", 0.65, 1.0]] }
      )
    );
    rows.push([1.25, 130, "amber"]);
    note(s, 0.6, "insert", "ink");
    note(s, 1.3, "5 rows", "dim");
  } else {
    s.cards.push(
      card(
        28,
        "amber",
        [
          [
            [
              [24, Y],
              [250, Y],
            ],
            0.6,
            0.5,
          ],
          [
            [
              [250, Y],
              [24, Y],
            ],
            1.3,
            0.6,
          ],
        ],
        0.6,
        1.95,
        {
          col: [[1.18, "red"]],
          lean: [1.3],
          tags: [
            ["insert", 0.65, 1.0],
            ["conflict", 1.45, 1.9],
          ],
        }
      )
    );
    note(s, 0.6, "insert", "ink");
    note(s, 1.25, "rejected · unique key", "red");
  }
  if (kind === "not found") {
    s.cards.push(
      card(
        28,
        "red",
        [
          [
            [
              [330, Y],
              [616, Y],
            ],
            2.45,
            0.6,
          ],
        ],
        2.45,
        3.1,
        { tags: [["row 9 · not found", 2.6, 3.05]] }
      )
    );
    note(s, 1.95, "read · row 9", "ink");
    note(s, 2.45, "not found", "red");
    return {
      name: kind,
      still: 2.75,
      timeline: seal(s),
      extra: { rows, sweep: 1.95, read: 2.35 },
    };
  }
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [330, Y],
            [616, Y],
          ],
          2.4,
          0.6,
        ],
      ],
      2.4,
      3.05,
      { tags: [["row 2", 2.55, 3.0]] }
    )
  );
  note(s, 2.4, "read · row 2", "ink");
  return {
    name: kind,
    still: 1.5,
    timeline: seal(s),
    extra: { rows, sweep: null, read: 2.35 },
  };
}

/** The amber read highlight over one bar. */
function Lit({
  y,
  w,
  k,
  role = "amber",
}: {
  y: number;
  w: number;
  k: number;
  role?: StateRole | "edge";
}) {
  if (k <= 0) return null;
  return (
    <g opacity={k}>
      <Bar x={X} y={y} w={w} role={role} still />
    </g>
  );
}

export const storeMachine: MachinePartDef<StoreExtra> = {
  part: {
    name: "store",
    job: "keeps records",
    aka: "database table · KV · history · log",
  },
  family: "data and state",
  footprint: "M",
  bb: [230, 88, 180, 230],
  status: { x: 320, y: 346 },
  scenarios: [
    storeStory("insert · read"),
    storeStory("unique conflict"),
    storeStory("not found"),
  ],
  draw: (t, { rows, sweep, read }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [230, Y],
        ]}
      />
      <Rail
        points={[
          [410, Y],
          [616, Y],
        ]}
      />
      <PartBox x={230} y={88} w={180} h={230} />
      {rows.map(([a, w, role], i) => {
        const y = 110 + i * 16;
        if (sweep != null) {
          const from = sweep + i * 0.08;
          const lit = windowed(t, from, from + 0.05);
          if (a >= 0 && t < a) return null;
          return (
            <g key={i}>
              <Bar
                x={X}
                y={y}
                w={w}
                role={role}
                k={a < 0 ? 1 : pop(t - a)}
                still={a < 0}
              />
              <Lit y={y} w={w} k={lit} />
            </g>
          );
        }
        if (a < 0)
          return (
            <g key={i}>
              <Bar x={X} y={y} w={w} role={role} still />
              {i === 1 && (
                <Lit y={y} w={w} k={windowed(t, read - 0.2, read + 0.1)} />
              )}
            </g>
          );
        return t >= a ? (
          <Bar key={i} x={X} y={y} w={w} role={role} k={pop(t - a)} />
        ) : null;
      })}
    </>
  ),
};
