/**
 * run end · stop pauses, finish completes (catalogue "run end"): a stop bar
 * that drops across the rail, and the finish terminal. Ported from the
 * gallery line for line.
 */
import { PartBox, Ring, Terminal } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { clamp, track } from "../motion";
import { roleColor } from "../palette";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, gateV, note, seal, story } from "../timeline";
import { PlateLine } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

interface RunEndExtra {
  /** Stop bar position `[at, 0..1]`: springs to each entry. */
  readonly bar: readonly (readonly [number, number])[];
  /** When the finish terminal fills. */
  readonly done: number | null;
  /** The stopping ring around the run, `[from, to]`, centred on x `ringX` (default 160). */
  readonly ring: readonly [number, number] | null;
  readonly ringX?: number;
  /** The dashed stop-taskrun lane from above, `[x, y0, y1]`. */
  readonly lane: readonly [number, number, number] | null;
}

function runEndStory(
  kind: "finish · task done" | "stopped by user" | "stop step · next run"
): PartScenario<RunEndExtra> {
  const f = kind === "stopped by user";
  const s = story(kind === "stop step · next run" ? 5.2 : 4.6);
  s.gates.push(gateV(270, Y), gateV(390, Y));
  if (kind === "stop step · next run") {
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
        2.4,
        { col: [[1.5, "edge"]], tags: [["run 1", 0.65, 1.0]] }
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
              [500, Y],
            ],
            2.9,
            0.6,
          ],
        ],
        2.85,
        3.9,
        { tags: [["run 2", 2.95, 3.6]] }
      )
    );
    note(s, 0.6, "run 1 at stop step", "ink");
    note(s, 1.5, "run 1 stopped · task open", "dim");
    note(s, 2.7, "next TaskRun starts", "ink");
    note(s, 3.2, "continues from the stop", "dim");
    return {
      name: kind,
      still: 1.8,
      timeline: seal(s),
      extra: {
        bar: [
          [0, 0],
          [0.9, 1],
          [2.7, 0],
        ],
        done: null,
        ring: null,
        lane: null,
      },
    };
  }
  if (f) {
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [24, Y],
              [160, Y],
            ],
            0.6,
            0.6,
          ],
        ],
        0.6,
        3.6,
        { col: [[2.1, "edge"]], tags: [["run 1", 0.65, 1.0]] }
      )
    );
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [160, 96],
              [160, 170],
            ],
            0.9,
            0.4,
          ],
        ],
        0.9,
        1.4,
        { hollow: true, tags: [["stop", 0.95, 1.35]] }
      )
    );
    note(s, 0.6, "run working", "ink");
    note(s, 1.2, "stop-taskrun · stopping", "amber");
    note(s, 2.1, "stopped · task not done", "dim");
    return {
      name: kind,
      still: 1.6,
      timeline: seal(s),
      extra: {
        bar: [[0, 0]],
        done: null,
        ring: [1.2, 2.1],
        lane: [160, 96, 170],
      },
    };
  }
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [24, Y],
            [546, Y],
          ],
          0.6,
          0.9,
        ],
      ],
      0.6,
      1.6,
      { tags: [["run 1", 0.65, 1.0]] }
    )
  );
  note(s, 0.6, "run working", "ink");
  note(s, 1.5, "finish · task completed", "green");
  return {
    name: kind,
    still: 1.7,
    timeline: seal(s),
    extra: { bar: [[0, 0]], done: 1.5, ring: null, lane: null },
  };
}

export const runEndMachine: MachinePartDef<RunEndExtra> = {
  part: {
    name: "run end",
    job: "stop pauses, finish completes",
    aka: "stop · finish · stop-taskrun",
  },
  family: "vertebrae workflows",
  footprint: "S",
  bb: [270, 140, 120, 120],
  status: { x: 330, y: 318 },
  scenarios: [
    runEndStory("finish · task done"),
    runEndStory("stopped by user"),
    runEndStory("stop step · next run"),
  ],
  draw: (t, { bar, done, ring, ringX = 160, lane }) => {
    const k = track(bar, t, clamp);
    return (
      <>
        <Rail
          points={[
            [24, Y],
            [546, Y],
          ]}
        />
        {lane && (
          <Rail
            points={[
              [lane[0], lane[1]],
              [lane[0], lane[2]],
            ]}
            dashed
            dash="4 6"
          />
        )}
        <PartBox x={270} y={140} w={120} h={120} r={12} />
        <SvgText
          x={330}
          y={282}
          runs={[["stop", 400, "dim"]]}
          size={18}
          align="center"
        />
        <rect
          x={316}
          y={150}
          width={28}
          height={8}
          rx={3}
          fill={roleColor("edge")}
        />
        <PlateLine x1={330} y1={158} x2={330} y2={160 + (Y + 18 - 160) * k} />
        <Terminal x={560} y={Y} t={t} at={done} role="green" />
        <SvgText
          x={560}
          y={236}
          runs={[["finish", 400, "dim"]]}
          size={18}
          align="center"
        />
        {ring && (
          <Ring
            x={ringX}
            y={Y}
            t={t}
            from={ring[0]}
            to={ring[1]}
            result="edge"
            r={22}
          />
        )}
      </>
    );
  },
};
