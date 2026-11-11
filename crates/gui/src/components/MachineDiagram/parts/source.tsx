/**
 * source · emits work (catalogue "source"): a small box with a caret that
 * ejects cards onto one out rail. Ported from the gallery artifact
 * (vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a) line for line.
 */
import { PartBox } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { roleColor } from "../palette";
import { Rail } from "../Rail";
import { Glyph } from "../SvgText";
import { card, note, seal, story, type Timeline } from "../timeline";
import type { MachinePartDef } from "./types";

function sourceStory(kind: "sends" | "no listener" | "burst"): Timeline {
  const s = story(3.6);
  if (kind === "burst") {
    for (let i = 0; i < 5; i++) {
      const a = 0.6 + 0.12 * i;
      s.cards.push(
        card(
          28,
          "amber",
          [
            [
              [
                [190, Y],
                [600, Y],
              ],
              a,
              0.7,
            ],
          ],
          a,
          a + 0.72,
          { tags: i === 4 ? [["5 at once", 0.75, 1.4]] : [] }
        )
      );
    }
    note(s, 0.6, "burst · 5 in 0.5 s", "amber");
    note(s, 1.8, "ready", "dim");
    return seal(s);
  }
  const f = kind === "no listener";
  s.cards.push(
    card(
      28,
      "amber",
      [
        [
          [
            [190, Y],
            [600, Y],
          ],
          0.6,
          0.7,
        ],
      ],
      0.6,
      1.32,
      { tags: [["request", 0.65, 1.1]] }
    )
  );
  s.cards.push(
    f
      ? card(
          28,
          "amber",
          [
            [
              [
                [190, Y],
                [380, Y],
              ],
              2.0,
              0.5,
            ],
          ],
          2.0,
          2.75,
          { col: [[2.5, "red"]], tags: [["no listener", 2.5, 3.0]] }
        )
      : card(
          28,
          "amber",
          [
            [
              [
                [190, Y],
                [600, Y],
              ],
              2.0,
              0.7,
            ],
          ],
          2.0,
          2.72,
          { tags: [["tick", 2.05, 2.5]] }
        )
  );
  note(s, 0.6, "send", "ink");
  note(s, 1.3, "ready", "dim");
  note(s, 2.0, f ? "dropped" : "send", f ? "red" : "ink");
  return seal(s);
}

export const sourceMachine: MachinePartDef<null> = {
  part: {
    name: "source",
    job: "emits work",
    aka: "person · trigger · scheduler · watcher",
  },
  family: "actors",
  footprint: "S",
  bb: [110, 168, 80, 64],
  status: { x: 150, y: 262 },
  scenarios: [
    { name: "sends", still: 1.0, timeline: sourceStory("sends"), extra: null },
    {
      name: "no listener",
      still: 1.0,
      timeline: sourceStory("no listener"),
      extra: null,
    },
    { name: "burst", still: 1.25, timeline: sourceStory("burst"), extra: null },
  ],
  draw: (t) => (
    <>
      <Rail
        points={[
          [190, Y],
          [600, Y],
        ]}
      />
      <PartBox x={110} y={168} w={80} h={64} r={12} />
      <Glyph x={128} y={Y} text=">" size={26} role="ink" />
      {Math.floor(t * 4) % 2 === 0 && (
        <rect x={140} y={Y + 6} width={14} height={3} fill={roleColor("ink")} />
      )}
    </>
  ),
};
