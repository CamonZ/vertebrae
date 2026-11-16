/**
 * inference step · one agent turn (catalogue "inference step"): the press,
 * plus a tools box the agent calls out to while clamped. Ported from the
 * gallery line for line.
 */
import { PartBox } from "../fixtures";
import { litAt } from "../geometry";
import { RAIL_Y as Y } from "../MachinePart";
import { held } from "../motion";
import { Press } from "../Press";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, dot, gateV, note, seal, story } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

interface InferenceExtra {
  /** Clamp engaged / released. */
  readonly cl: readonly [number, number];
  /** When each press light comes on. */
  readonly lights: readonly number[];
}

function inferenceStory(
  kind: "done" | "output fails schema" | "tool calls"
): PartScenario<InferenceExtra> {
  const tools = kind === "tool calls";
  const f = kind === "output fails schema";
  const s = story(tools ? 5.8 : 4.6);
  const cl: [number, number] = tools ? [1.25, 3.9] : [1.25, 2.6];
  const lights = tools
    ? [1.35, 1.9, 2.6, 3.3, 3.6, 3.9]
    : [1.35, 1.6, 1.85, 2.1, 2.35, 2.6];
  const amber = (t: number) => held(t, cl[0], cl[1]);
  s.gates.push(gateV(200, Y, amber), gateV(440, Y, amber));
  if (tools) {
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
        ],
        0.6,
        4.05,
        { tags: [["prompt", 0.65, 1.0]] }
      )
    );
    (
      [
        ["read", 1.5],
        ["edit", 2.2],
        ["test", 2.9],
      ] as const
    ).forEach(([n, a]) => {
      s.cards.push(
        dot(
          [
            [380, 150],
            [380, 88],
            [474, 88],
          ],
          a,
          0.35,
          "amber",
          { tags: [[n, a + 0.05, a + 0.5, -20]] }
        )
      );
      s.cards.push(
        dot(
          [
            [474, 88],
            [380, 88],
            [380, 150],
          ],
          a + 0.4,
          0.3,
          "ink"
        )
      );
    });
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [320, Y],
              [616, Y],
            ],
            3.95,
            0.6,
          ],
        ],
        3.95,
        4.6,
        { col: [[4.25, "green"]], tags: [["output", 4.1, 4.55]] }
      )
    );
    note(s, 0.6, "prompt in · claude", "ink");
    note(s, 1.35, "agent working", "dim");
    note(s, 1.5, "tool call · read", "amber");
    note(s, 2.2, "tool call · edit", "amber");
    note(s, 2.9, "tool call · test", "amber");
    note(s, 3.95, "done · output fits schema", "green");
    return {
      name: kind,
      still: 2.5,
      timeline: seal(s),
      extra: { cl, lights },
    };
  }
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
      ],
      0.6,
      2.75,
      { tags: [["prompt", 0.65, 1.0]] }
    )
  );
  s.cards.push(
    card(
      28,
      "ink",
      [[[[320, Y], f ? [520, Y] : [616, Y]], 2.65, 0.6]],
      2.65,
      f ? 4.1 : 3.4,
      {
        col: [[2.95, f ? "red" : "green"]],
        tags: [[f ? "no plan field" : "output", 2.95, f ? 4.0 : 3.35]],
      }
    )
  );
  note(s, 0.6, "prompt in · claude", "ink");
  note(s, 1.35, "agent working", "dim");
  note(
    s,
    2.95,
    f ? "output fails schema · step failed" : "done · output fits schema",
    f ? "red" : "green"
  );
  return {
    name: kind,
    still: f ? 3.3 : 2.0,
    timeline: seal(s),
    extra: { cl, lights },
  };
}

export const inferenceStepMachine: MachinePartDef<InferenceExtra> = {
  part: {
    name: "inference step",
    job: "one agent turn",
    aka: "llm_inference · claude · codex · mistral vibe",
  },
  family: "vertebrae workflows",
  footprint: "M",
  bb: [200, 105, 240, 190],
  status: { x: 320, y: 328 },
  scenarios: [
    inferenceStory("done"),
    inferenceStory("output fails schema"),
    inferenceStory("tool calls"),
  ],
  draw: (t, { cl, lights }) => (
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
          [616, Y],
        ]}
      />
      <Rail
        points={[
          [380, 105],
          [380, 88],
          [474, 88],
        ]}
      />
      <PartBox x={474} y={64} w={104} h={48} r={12} />
      <SvgText
        x={526}
        y={89}
        runs={[["tools", 400, "dim"]]}
        size={18}
        align="center"
      />
      <PartBox x={200} y={105} w={240} h={190} />
      <Press
        cx={320}
        cy={Y}
        half={80}
        closed={held(t, cl[0], cl[1])}
        lit={litAt(lights, t, cl[1] + 0.5)}
        clampAt={cl[0]}
        t={t}
      />
    </>
  ),
};
