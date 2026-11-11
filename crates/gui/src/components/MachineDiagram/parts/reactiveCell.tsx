/**
 * reactive cell · tells readers it changed (catalogue "reactive cell"): a cell
 * holding a value, with one reader rail per reader; a reader's lamp lights
 * when the change reaches it. A write of the same value stays quiet. Ported
 * from the gallery line for line.
 */
import { Lamp, PartBox } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { pop, smoothstep } from "../motion";
import type { CardRole } from "../palette";
import { Rail } from "../Rail";
import { StatusLine } from "../StatusLine";
import {
  card,
  gateV,
  note,
  seal,
  statusAt,
  story,
  type StatusNote,
} from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

interface ReactiveCellExtra {
  /** The value shown in the cell over time (same swap as the status line). */
  readonly val: readonly StatusNote[];
  /** Each reader's lamp: `[litAt, role]`. */
  readonly hit: readonly (readonly [number, CardRole])[];
}

const READERS = [130, 270] as const;
const UP = [
  [350, 175],
  [440, 175],
  [440, 130],
  [560, 130],
] as const;
const DOWN = [
  [350, 225],
  [440, 225],
  [440, 270],
  [560, 270],
] as const;

function cellStory(
  kind: "readers updated" | "reader fails"
): PartScenario<ReactiveCellExtra> {
  const f = kind === "reader fails";
  const s = story(5.2);
  s.gates.push(gateV(220, Y), gateV(350, 175), gateV(350, 225));
  const set = (a: number) =>
    card(
      28,
      "amber",
      [
        [
          [
            [24, Y],
            [285, Y],
          ],
          a,
          0.6,
        ],
      ],
      a,
      a + 0.65,
      { tags: [["set 4", a + 0.05, a + 0.4]] }
    );
  s.cards.push(set(0.6));
  s.cards.push(
    card(
      18,
      "ink",
      [
        [
          [
            [300, 175],
            [440, 175],
            [440, 130],
            [560, 130],
          ],
          1.4,
          0.6,
        ],
      ],
      1.4,
      2.05
    )
  );
  s.cards.push(
    card(
      18,
      f ? "red" : "ink",
      [
        [
          [
            [300, 225],
            [440, 225],
            [440, 270],
            [560, 270],
          ],
          1.5,
          0.6,
        ],
      ],
      1.5,
      2.15
    )
  );
  s.cards.push(set(3.0));
  note(s, 0.6, "", "dim");
  note(s, 1.3, "changed → 2 readers", "ink");
  note(s, 2.15, f ? "1 reader failed" : "readers updated", f ? "red" : "green");
  note(s, 3.65, "same value · quiet", "dim");
  return {
    name: kind,
    still: 1.6,
    timeline: seal(s),
    extra: {
      val: [
        [0, "3", "ink"],
        [1.2, "4", "ink"],
        [3.6, "4", "ink"],
      ],
      hit: [
        [2.05, "green"],
        [2.15, f ? "red" : "green"],
      ],
    },
  };
}

export const reactiveCellMachine: MachinePartDef<ReactiveCellExtra> = {
  part: {
    name: "reactive cell",
    job: "tells readers it changed",
    aka: "store slice · signal · observable · watch",
  },
  family: "data and state",
  footprint: "S",
  bb: [220, 150, 130, 100],
  status: { x: 285, y: 282 },
  scenarios: [cellStory("readers updated"), cellStory("reader fails")],
  draw: (t, { val, hit }) => (
    <>
      <Rail
        points={[
          [24, Y],
          [220, Y],
        ]}
      />
      <Rail points={UP} />
      <Rail points={DOWN} />
      <PartBox x={220} y={150} w={130} h={100} r={12} />
      <StatusLine status={statusAt(val, t)} x={285} y={Y} size={26} />
      {READERS.map((y, i) => {
        const [a, role] = hit[i];
        return (
          <g key={y}>
            <PartBox x={560} y={y - 24} w={56} h={48} r={12} />
            <Lamp
              x={588}
              y={y}
              r={9}
              role={t >= a ? role : null}
              k={pop(t - a) * (1 - smoothstep(a + 1.2, a + 1.5, t))}
            />
          </g>
        );
      })}
    </>
  ),
};
