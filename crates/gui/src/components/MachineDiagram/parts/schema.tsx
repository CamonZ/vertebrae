/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism component */
/**
 * schema · checks the shape (catalogue "schema"): a check box between the in
 * and out rails; a value that fits passes, a misfit stops at the check, and
 * an old version is upgraded and then fits. Ported from the gallery line for
 * line.
 */
import { PartBox } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { held } from "../motion";
import type { CardRole } from "../palette";
import { roleColor } from "../palette";
import { usePart } from "../partContext";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story } from "../timeline";
import { Outline, Strokes } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

interface SchemaExtra {
  /** The check frame flashes `[from, role]` for 0.6 s each. */
  readonly fit: readonly (readonly [number, CardRole])[];
  /** Amber glow behind the check while a value is being upgraded. */
  readonly glow: readonly [number, number] | null;
}

function schemaStory(
  kind: "fits" | "missing id" | "old version migrated"
): PartScenario<SchemaExtra> {
  const s = story(5.0);
  s.gates.push(gateV(210, Y), gateV(430, Y));
  const fit: [number, CardRole][] = [[1.2, "green"]];
  s.cards.push(
    card(
      36,
      "ink",
      [
        [
          [
            [24, Y],
            [320, Y],
          ],
          0.6,
          0.6,
        ],
        [
          [
            [320, Y],
            [616, Y],
          ],
          1.55,
          0.6,
        ],
      ],
      0.6,
      2.2,
      {
        col: [[1.43, "green"]],
        tags: [
          ["{id,name}", 0.65, 1.0],
          ["valid", 1.7, 2.15],
        ],
      }
    )
  );
  if (kind === "old version migrated") {
    s.cards.push(
      card(
        52,
        "ink",
        [
          [
            [
              [24, Y],
              [300, Y],
            ],
            2.6,
            0.6,
          ],
        ],
        2.6,
        3.42,
        { h: 30, col: [[3.0, "amber"]], tags: [["v1 {name}", 2.65, 3.0]] }
      )
    );
    s.cards.push(
      card(
        36,
        "amber",
        [
          [
            [
              [320, Y],
              [320, Y],
            ],
            3.4,
            0.05,
          ],
          [
            [
              [320, Y],
              [616, Y],
            ],
            3.75,
            0.6,
          ],
        ],
        3.38,
        4.4,
        {
          col: [[3.63, "green"]],
          lean: [3.75],
          tags: [["v2 {id,name}", 3.9, 4.35]],
        }
      )
    );
    fit.push([3.0, "amber"], [3.6, "green"]);
    note(s, 0.6, "checking", "dim");
    note(s, 1.3, "fits", "green");
    note(s, 2.6, "checking", "dim");
    note(s, 3.0, "v1 · upgrading", "amber");
    note(s, 3.6, "migrated · fits", "green");
    return {
      name: kind,
      still: 3.35,
      timeline: seal(s),
      extra: { fit, glow: [3.0, 3.6] },
    };
  }
  const f = kind === "missing id";
  if (f) {
    s.cards.push(
      card(
        52,
        "ink",
        [
          [
            [
              [24, Y],
              [300, Y],
            ],
            2.6,
            0.6,
          ],
          [
            [
              [300, Y],
              [24, Y],
            ],
            3.45,
            0.6,
          ],
        ],
        2.6,
        4.1,
        {
          h: 30,
          col: [[3.33, "red"]],
          lean: [3.45],
          tags: [
            ["{name}", 2.65, 3.0],
            ["missing id", 3.6, 4.05],
          ],
        }
      )
    );
    fit.push([3.2, "red"]);
  } else {
    s.cards.push(
      card(
        36,
        "ink",
        [
          [
            [
              [24, Y],
              [320, Y],
            ],
            2.6,
            0.6,
          ],
          [
            [
              [320, Y],
              [616, Y],
            ],
            3.55,
            0.6,
          ],
        ],
        2.6,
        4.2,
        {
          col: [[3.43, "green"]],
          tags: [["{id,name}", 2.65, 3.0]],
        }
      )
    );
    fit.push([3.2, "green"]);
  }
  note(s, 0.6, "checking", "dim");
  note(s, 1.3, "fits", "green");
  note(s, 2.6, "checking", "dim");
  note(s, 3.3, f ? "rejected · missing id" : "fits", f ? "red" : "green");
  return {
    name: kind,
    still: 1.3,
    timeline: seal(s),
    extra: { fit, glow: null },
  };
}

function Glow({ k }: { k: number }) {
  const { fade } = usePart();
  return (
    <rect
      x={290}
      y={Y - 22}
      width={60}
      height={44}
      fill={roleColor("amber")}
      opacity={0.22 * k * fade}
    />
  );
}

export const schemaMachine: MachinePartDef<SchemaExtra> = {
  part: {
    name: "schema",
    job: "checks the shape",
    aka: "validator · type · contract · migration check",
  },
  family: "data and state",
  footprint: "M",
  bb: [210, 120, 220, 160],
  status: { x: 320, y: 312 },
  scenarios: [
    schemaStory("fits"),
    schemaStory("missing id"),
    schemaStory("old version migrated"),
  ],
  draw: (t, { fit, glow }) => {
    let role: CardRole = "edge";
    for (const [a, c] of fit) if (t >= a && t < a + 0.6) role = c;
    const k = glow ? held(t, glow[0], glow[1]) : 0;
    return (
      <>
        <Rail
          points={[
            [24, Y],
            [210, Y],
          ]}
        />
        <Rail
          points={[
            [430, Y],
            [616, Y],
          ]}
        />
        <PartBox x={210} y={120} w={220} h={160} />
        {k > 0 && <Glow k={k} />}
        <Outline x={298} y={186} w={44} h={28} r={5} role={role} dash="5 4" />
        <Strokes
          lines={[
            [
              [270, 170],
              [296, 182],
            ],
            [
              [270, 230],
              [296, 218],
            ],
            [
              [370, 170],
              [344, 182],
            ],
            [
              [370, 230],
              [344, 218],
            ],
          ]}
        />
        <SvgText
          x={320}
          y={252}
          runs={[["{id, name}", 400, "dim"]]}
          size={18}
          align="center"
        />
      </>
    );
  },
};
