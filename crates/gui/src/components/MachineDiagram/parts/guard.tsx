/**
 * guard · allows or denies (catalogue "guard"): a check hole between in and
 * out; a deny drops to the dashed lane below. Ported from the gallery
 * artifact (vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a) line for line.
 */
import { Hole, PartBox, Ring } from "../fixtures";
import type { CardRole } from "../palette";
import { Rail } from "../Rail";
import type { Point } from "../route";
import { SvgText } from "../SvgText";
import { card, gateH, gateV, note, seal, story } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

/** The guard's rail sits at 195, not the 200 centre. */
const Y = 195;
const SLOT: Point = [320, Y];

interface GuardExtra {
  /** Decision rings `[from, to, result]`. */
  readonly rings: readonly (readonly [number, number, CardRole])[];
}

function guardStory(
  kind: "allow · deny" | "policy gap" | "not signed in"
): PartScenario<GuardExtra> {
  const s = story(5.2);
  s.gates.push(gateV(220, Y), gateV(420, Y), gateH(320, 270));
  if (kind === "not signed in") {
    s.cards.push(
      card(
        28,
        "amber",
        [
          [
            [
              [24, Y],
              [196, Y],
            ],
            0.6,
            0.55,
          ],
          [
            [
              [196, Y],
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
            ["read", 0.65, 1.0],
            ["401", 1.45, 1.9],
          ],
        }
      )
    );
    s.cards.push(
      card(
        28,
        "amber",
        [
          [[[24, Y], SLOT], 2.4, 0.6],
          [[SLOT, [320, 330]], 3.7, 0.5],
        ],
        2.4,
        4.25,
        {
          badge: true,
          col: [[3.58, "red"]],
          lean: [3.7],
          tags: [
            ["write", 2.45, 2.8],
            ["403", 3.8, 4.2, 0],
          ],
        }
      )
    );
    note(s, 0.6, "read · no identity", "amber");
    note(s, 1.2, "401 · not signed in", "red");
    note(s, 2.4, "write · deciding", "amber");
    note(s, 3.7, "403 · signed in, not allowed", "red");
    return {
      name: kind,
      still: 1.65,
      timeline: seal(s),
      extra: { rings: [[3.0, 3.7, "red"]] },
    };
  }
  const f = kind === "policy gap";
  s.cards.push(
    card(
      28,
      "amber",
      [
        [[[24, Y], SLOT], 0.6, 0.6],
        [[SLOT, [616, Y]], 1.9, 0.6],
      ],
      0.6,
      2.55,
      {
        badge: true,
        col: [[1.78, "green"]],
        lean: [1.9],
        tags: [
          ["read", 0.65, 1.0],
          ["allowed", 2.05, 2.5],
        ],
      }
    )
  );
  s.cards.push(
    card(
      28,
      "amber",
      [
        [[[24, Y], SLOT], 2.4, 0.6],
        f ? [[SLOT, [616, Y]], 3.7, 0.6] : [[SLOT, [320, 330]], 3.7, 0.5],
      ],
      2.4,
      4.25,
      {
        badge: true,
        col: [[3.58, f ? "green" : "red"]],
        lean: [3.7],
        tags: [
          ["write", 2.45, 2.8],
          [f ? "allowed (bug)" : "denied", 3.8, 4.2, 0],
        ],
      }
    )
  );
  note(s, 0.6, "read · deciding", "amber");
  note(s, 1.9, "allow", "green");
  note(s, 2.4, "write · deciding", "amber");
  note(s, 3.7, f ? "allowed · policy gap" : "deny · read only", "red");
  return {
    name: kind,
    still: 3.25,
    timeline: seal(s),
    extra: {
      rings: [
        [1.2, 1.9, "green"],
        [3.0, 3.7, f ? "green" : "red"],
      ],
    },
  };
}

export const guardMachine: MachinePartDef<GuardExtra> = {
  part: {
    name: "guard",
    job: "allows or denies",
    aka: "permission check · auth middleware · policy",
  },
  family: "policy",
  footprint: "S",
  bb: [220, 120, 200, 150],
  status: { x: 470, y: 300 },
  scenarios: [
    guardStory("allow · deny"),
    guardStory("policy gap"),
    guardStory("not signed in"),
  ],
  draw: (t, { rings }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [220, Y],
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
          [320, 270],
          [320, 320],
        ]}
        dashed
        dash="4 6"
      />
      <PartBox x={220} y={120} w={200} h={150} />
      <Hole x={320} y={Y} />
      {rings.map(([a, b, c], i) => (
        <Ring key={i} x={320} y={Y} t={t} from={a} to={b} result={c} />
      ))}
      <SvgText
        x={306}
        y={318}
        runs={[["deny", 400, "dim"]]}
        size={18}
        align="right"
      />
    </>
  ),
};
