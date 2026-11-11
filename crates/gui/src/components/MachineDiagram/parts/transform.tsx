/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism component */
/**
 * transform · changes the shape (catalogue "transform"): a die whose guides
 * narrow the path and a stamp that drops on the card; it leaves with a new
 * shape and tag. Ported from the gallery line for line.
 */
import { PartBox } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { held } from "../motion";
import { roleColor } from "../palette";
import { usePart } from "../partContext";
import { Rail } from "../Rail";
import { card, gateV, note, seal, story } from "../timeline";
import { PlateLine, Strokes } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

/** The stamp drops for 0.25 s from here. */
const STAMP_AT = 1.25;

function transformStory(f: boolean): PartScenario<null> {
  const s = story(4.0);
  s.gates.push(gateV(200, Y), gateV(440, Y));
  s.cards.push(
    card(
      36,
      "ink",
      [
        [
          [
            [24, Y],
            [296, Y],
          ],
          0.6,
          0.6,
        ],
      ],
      0.6,
      1.32,
      { tags: [["json", 0.65, 1.0]] }
    )
  );
  s.cards.push(
    card(
      18,
      f ? "red" : "ink",
      [
        [
          [
            [344, Y],
            [616, Y],
          ],
          1.45,
          0.6,
        ],
      ],
      1.38,
      2.1,
      { h: 28, tags: [[f ? "parse error" : "Task", 1.6, 2.05, -26]] }
    )
  );
  note(s, 0.6, "json in", "ink");
  note(s, 1.3, "stamping", "dim");
  note(s, 1.5, f ? "failed · bad field" : "Task out", f ? "red" : "green");
  return {
    name: f ? "parse error" : "Task out",
    still: 1.35,
    timeline: seal(s),
    extra: null,
  };
}

function Stamp({ t, at }: { t: number; at: number }) {
  const { fade } = usePart();
  const k = held(t, at, at + 0.25);
  return (
    <>
      <rect
        x={296}
        y={134}
        width={48}
        height={8}
        rx={3}
        fill={roleColor("edge")}
      />
      <PlateLine x1={320} y1={142} x2={320} y2={150 + 8 * k} />
      <rect
        x={304}
        y={148 + 8 * k}
        width={32}
        height={8}
        fill={roleColor("plate")}
      />
      {k > 0 && (
        <rect
          x={298}
          y={Y - 18}
          width={44}
          height={36}
          fill={roleColor("amber")}
          opacity={0.22 * k * fade}
        />
      )}
    </>
  );
}

export const transformMachine: MachinePartDef<{
  readonly stampAt: number;
} | null> = {
  part: {
    name: "transform",
    job: "changes the shape",
    aka: "parser · serializer · mapper · codec",
  },
  family: "compute",
  footprint: "M",
  bb: [200, 120, 240, 160],
  status: { x: 320, y: 312 },
  scenarios: [transformStory(false), transformStory(true)],
  draw: (t, extra) => (
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
      <PartBox x={200} y={120} w={240} h={160} />
      <Strokes
        lines={[
          [
            [232, Y - 40],
            [296, Y - 24],
            [344, Y - 24],
            [408, Y - 40],
          ],
          [
            [232, Y + 40],
            [296, Y + 24],
            [344, Y + 24],
            [408, Y + 40],
          ],
        ]}
      />
      <Stamp t={t} at={extra?.stampAt ?? STAMP_AT} />
    </>
  ),
};
