/**
 * state machine · one state at a time (catalogue "state machine"): state
 * nodes with a cursor that moves along legal edges; an event that has no
 * edge from the current state is rejected at the frame. Ported from the
 * gallery line for line.
 */
import { PartBox } from "../fixtures";
import { Rail } from "../Rail";
import type { Point } from "../route";
import { SvgText } from "../SvgText";
import { roleColor } from "../palette";
import { card, gateV, note, seal, stay, story } from "../timeline";
import { Strokes } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

/** `[x, y, label, labelDx, labelDy]`: queued → running → done, running → failed. */
const NODES = [
  [190, 150, "queued", 0, 34],
  [330, 150, "running", 0, 34],
  [470, 150, "done", 0, 34],
  [330, 240, "failed", 56, 0],
] as const;

const Q: Point = [190, 150];
const R: Point = [330, 150];
const D: Point = [470, 150];
const X: Point = [330, 240];

function stateMachineStory(
  kind: "done" | "failed" | "invalid transition"
): PartScenario<null> {
  const bad = kind === "invalid transition";
  const f = kind === "failed";
  const s = story(bad ? 6.0 : 4.8);
  s.gates.push(gateV(110, 150));
  // The cursor is the machine's current state, drawn as a dot on the nodes.
  s.cards.push(
    card(
      18,
      "dim",
      [stay(...Q, 0.6), [[Q, R], 1.25, 0.4], [[R, f ? X : D], 2.75, 0.4]],
      0.6,
      s.period - 0.5,
      {
        dot: true,
        col: [
          [1.25, "amber"],
          [2.85, f ? "red" : "green"],
        ],
      }
    )
  );
  if (bad) {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, 150],
              [140, 150],
            ],
            3.4,
            0.4,
          ],
          [
            [
              [140, 150],
              [70, 150],
            ],
            3.95,
            0.5,
          ],
        ],
        3.4,
        4.6,
        {
          col: [[3.83, "red"]],
          lean: [3.95],
          tags: [
            ["start", 3.45, 3.8],
            ["invalid", 4.0, 4.5, 32],
          ],
        }
      )
    );
    note(s, 3.85, "done → running · rejected", "red");
  }
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, 150],
            [150, 150],
          ],
          0.85,
          0.4,
        ],
      ],
      0.85,
      1.3,
      { tags: [["start", 0.9, 1.2]] }
    )
  );
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, 150],
            [150, 150],
          ],
          2.35,
          0.4,
        ],
      ],
      2.35,
      2.8,
      { tags: [[f ? "error" : "finish", 2.4, 2.7]] }
    )
  );
  note(s, 0.6, "queued", "dim");
  note(s, 1.3, "running", "amber");
  note(s, 2.85, f ? "failed" : "done", f ? "red" : "green");
  return {
    name: kind,
    still: bad ? 4.4 : 2.4,
    timeline: seal(s),
    extra: null,
  };
}

export const stateMachineMachine: MachinePartDef<null> = {
  part: {
    name: "state machine",
    job: "one state at a time",
    aka: "workflow step · lifecycle · reducer · FSM",
  },
  family: "data and state",
  footprint: "L",
  bb: [110, 100, 420, 190],
  status: { x: 320, y: 322 },
  scenarios: [
    stateMachineStory("done"),
    stateMachineStory("failed"),
    stateMachineStory("invalid transition"),
  ],
  draw: () => (
    <>
      <Rail
        points={[
          [24, 150],
          [110, 150],
        ]}
      />
      <PartBox x={110} y={100} w={420} h={190} />
      <Strokes
        lines={[
          [
            [204, 150],
            [316, 150],
          ],
          [
            [344, 150],
            [456, 150],
          ],
          [
            [330, 164],
            [330, 226],
          ],
        ]}
        role="rail"
        w={2.5}
      />
      {NODES.map(([x, y, label, dx, dy]) => (
        <g key={label}>
          <circle
            cx={x}
            cy={y}
            r={14}
            fill={roleColor("hole")}
            stroke={roleColor("edge")}
            strokeWidth={2}
          />
          <SvgText
            x={x + dx}
            y={y + dy}
            runs={[[label, 400, "dim"]]}
            size={18}
            align={dx ? "left" : "center"}
          />
        </g>
      ))}
    </>
  ),
};
