/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism component */
/**
 * splitter · copies to every branch (catalogue "splitter"): Y guides; one
 * card in, an origin-linked copy on each branch. Ported from the gallery
 * line for line.
 */
import { PartBox } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { smoothstep } from "../motion";
import { roleColor } from "../palette";
import { usePart } from "../partContext";
import { Rail } from "../Rail";
import { card, gateV, note, seal, story, type Timeline } from "../timeline";
import { Strokes } from "./draw";
import type { MachinePartDef } from "./types";

function splitterStory(f: boolean): Timeline {
  const s = story(4.2);
  s.gates.push(gateV(220, Y), gateV(400, 155), gateV(400, 245));
  s.cards.push(
    card(
      28,
      "ink",
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
      1.32,
      { tags: [["event", 0.65, 1.0]] }
    )
  );
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [300, Y],
            [340, Y],
            [400, 155],
            [600, 155],
          ],
          1.3,
          0.7,
        ],
      ],
      1.3,
      2.05,
      { tags: [["copy 1", 1.5, 2.0]] }
    )
  );
  s.cards.push(
    card(
      28,
      f ? "red" : "ink",
      [
        [
          [
            [300, Y],
            [340, Y],
            [400, 245],
            [600, 245],
          ],
          1.4,
          0.7,
        ],
      ],
      1.4,
      2.15,
      { tags: [[f ? "branch down" : "copy 2", 1.6, 2.1, 28]] }
    )
  );
  note(s, 0.6, "one in", "ink");
  note(s, 1.3, "copy ×2", "dim");
  note(
    s,
    2.1,
    f ? "1 of 2 delivered" : "2 of 2 delivered",
    f ? "red" : "green"
  );
  return seal(s);
}

/** The copy puff swells at the split point from here. */
const SPLIT_AT = 1.25;

function Puff({ t }: { t: number }) {
  const { fade } = usePart();
  const k =
    smoothstep(SPLIT_AT, SPLIT_AT + 0.1, t) *
    (1 - smoothstep(SPLIT_AT + 0.3, SPLIT_AT + 0.5, t));
  if (k <= 0) return null;
  return (
    <circle
      cx={300}
      cy={Y}
      r={10 + 10 * k}
      fill={roleColor("plate")}
      opacity={0.6 * k * fade}
    />
  );
}

export const splitterMachine: MachinePartDef<null> = {
  part: {
    name: "splitter",
    job: "copies to every branch",
    aka: "fan-out · broadcast · tee",
  },
  family: "compute",
  footprint: "S",
  bb: [220, 120, 180, 160],
  status: { x: 310, y: 312 },
  scenarios: [
    {
      name: "2 of 2",
      still: 1.55,
      timeline: splitterStory(false),
      extra: null,
    },
    {
      name: "branch down",
      still: 1.55,
      timeline: splitterStory(true),
      extra: null,
    },
  ],
  draw: (t) => (
    <>
      <Rail
        points={[
          [24, Y],
          [220, Y],
        ]}
      />
      <Rail
        points={[
          [400, 155],
          [600, 155],
        ]}
      />
      <Rail
        points={[
          [400, 245],
          [600, 245],
        ]}
      />
      <PartBox x={220} y={120} w={180} h={160} />
      <Strokes
        lines={[
          [
            [330, Y],
            [380, 160],
          ],
          [
            [330, Y],
            [380, 240],
          ],
        ]}
      />
      <Puff t={t} />
    </>
  ),
};
