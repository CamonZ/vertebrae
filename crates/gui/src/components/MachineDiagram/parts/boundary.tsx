/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism component */
/**
 * boundary · crossing costs a hop (catalogue "boundary"): a dashed region
 * with packets crossing its edge to a handler inside; on a partition the
 * edge is cut. Ported from the gallery line for line.
 */
import { PartBox } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { smoothstep } from "../motion";
import { roleColor } from "../palette";
import { usePart } from "../partContext";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story } from "../timeline";
import { Outline } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

interface BoundaryExtra {
  /** When the edge is cut (partition). */
  readonly cut: number | null;
}

/** Three packets serialize across the edge, 0.08 s apart. */
const packet = (a: number, dies: number, red: boolean) =>
  card(
    12,
    "ink",
    [
      [
        [
          [210, Y],
          [330, Y],
        ],
        a,
        0.4,
      ],
    ],
    a,
    dies,
    { h: 8, ...(red ? { col: [[a + 0.1, "red"] as const] } : {}) }
  );

function boundaryStory(
  kind: "crosses" | "refused" | "partition"
): PartScenario<BoundaryExtra> {
  const s = story(4.4);
  s.gates.push(gateV(230, Y));
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, Y],
            [228, Y],
          ],
          0.6,
          0.5,
        ],
      ],
      0.6,
      1.12,
      { tags: [["call", 0.65, 1.0]] }
    )
  );
  if (kind === "partition") {
    for (let i = 0; i < 3; i++) {
      const a = 1.05 + 0.08 * i;
      s.cards.push(packet(a, a + 0.16, true));
    }
    note(s, 0.6, "call", "ink");
    note(s, 1.05, "serialize · cross", "amber");
    note(s, 1.35, "hop lost", "red");
    note(s, 2.6, "caller gets no reply", "amber");
    return { name: kind, still: 1.6, timeline: seal(s), extra: { cut: 1.15 } };
  }
  if (kind === "crosses") {
    for (let i = 0; i < 3; i++) {
      const a = 1.05 + 0.08 * i;
      s.cards.push(packet(a, 1.55 + 0.08 * i, false));
    }
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [330, Y],
              [430, Y],
            ],
            1.75,
            0.4,
          ],
        ],
        1.7,
        2.2
      )
    );
    note(s, 0.6, "call", "ink");
    note(s, 1.05, "serialize · cross", "amber");
    note(s, 1.8, "inside", "ink");
  } else {
    s.cards.push(
      card(
        28,
        "red",
        [
          [
            [
              [228, Y],
              [24, Y],
            ],
            1.3,
            0.6,
          ],
        ],
        1.15,
        1.95,
        { lean: [1.3], tags: [["untrusted", 1.45, 1.9]] }
      )
    );
    note(s, 0.6, "call", "ink");
    note(s, 1.15, "refused at the edge", "red");
  }
  return { name: kind, still: 1.3, timeline: seal(s), extra: { cut: null } };
}

function Cut({ t, at }: { t: number; at: number }) {
  const { fade } = usePart();
  const k = smoothstep(at, at + 0.15, t) * fade;
  if (k <= 0) return null;
  return (
    <g stroke={roleColor("red")} strokeLinecap="round" opacity={k}>
      <line x1={230} y1={Y - 44} x2={230} y2={Y + 44} strokeWidth={3} />
      <path
        d={`M244 ${Y - 10} L264 ${Y + 10} M264 ${Y - 10} L244 ${Y + 10}`}
        strokeWidth={2.5}
        fill="none"
      />
    </g>
  );
}

export const boundaryMachine: MachinePartDef<BoundaryExtra> = {
  part: {
    name: "boundary",
    job: "crossing costs a hop",
    aka: "process · network · trust zone · container",
  },
  family: "topology and lifecycle",
  footprint: "L",
  bb: [230, 80, 340, 250],
  status: { x: 400, y: 356 },
  scenarios: [
    boundaryStory("crosses"),
    boundaryStory("refused"),
    boundaryStory("partition"),
  ],
  draw: (t, { cut }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [230, Y],
        ]}
      />
      <Rail
        points={[
          [330, Y],
          [430, Y],
        ]}
      />
      <Outline x={230} y={80} w={340} h={250} r={18} dash="8 7" />
      <g style={{ letterSpacing: "2.5px" }}>
        <SvgText
          x={252}
          y={108}
          runs={[["SACRUM PROCESS", 600, "dim"]]}
          size={18}
        />
      </g>
      <PartBox x={430} y={160} w={110} h={80} r={12} />
      <SvgText
        x={485}
        y={262}
        runs={[["handler", 400, "dim"]]}
        size={18}
        align="center"
      />
      {cut != null && <Cut t={t} at={cut} />}
    </>
  ),
};
