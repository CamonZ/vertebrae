/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism component */
/**
 * wait children · parks for child tasks (catalogue "wait children"): the
 * parent slot forks to one ring per child task, then a check on the combined
 * output. Ported from the gallery line for line.
 */
import { Hole, PartBox, Ring, Spinner } from "../fixtures";
import { arcPath } from "../geometry";
import type { CardRole } from "../palette";
import { roleColor } from "../palette";
import { usePart } from "../partContext";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, dot, gateV, note, seal, story } from "../timeline";
import { CheckFrame } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

const WY = 235;
const M = [315, WY] as const;
const CHILD_X = [255, 315, 375] as const;

interface WaitExtra {
  /** One ring per child: `[x, from, to, outcome | null]` (null keeps it waiting). */
  readonly rings: readonly (readonly [
    x: number,
    from: number,
    to: number,
    result: CardRole | null,
  ])[];
  readonly chk: readonly (readonly [number, CardRole])[];
}

function waitStory(
  kind: "all children done" | "combined output rejected" | "child still running"
): PartScenario<WaitExtra> {
  const still = kind === "child still running";
  const f = kind === "combined output rejected";
  const s = story(5.0);
  s.gates.push(gateV(180, WY), gateV(450, WY));
  const ends = [2.0, 2.6, still ? 99 : 3.1] as const;
  const rings: WaitExtra["rings"] = [
    [255, 1.3, ends[0], "green"],
    [315, 1.3, ends[1], "green"],
    [375, 1.3, still ? 4.4 : ends[2], still ? null : "green"],
  ];
  const chk: [number, CardRole][] = still ? [] : [[3.75, f ? "red" : "green"]];
  CHILD_X.forEach((x) =>
    s.cards.push(
      dot(
        [
          [315, 212],
          [x, 170],
        ],
        1.05,
        0.3,
        "amber",
        { dies: 1.4 }
      )
    )
  );
  if (still) {
    s.cards.push(
      card(28, "ink", [[[[24, WY], [...M]], 0.6, 0.55]], 0.6, 4.5, {
        tags: [["run", 0.65, 1.0]],
      })
    );
    note(s, 0.6, "run arrives", "ink");
    note(s, 1.05, "3 children forked", "dim");
    note(s, 2.0, "1 of 3 done", "amber");
    note(s, 2.6, "2 of 3 · run waiting", "amber");
    return {
      name: kind,
      still: 3.2,
      timeline: seal(s),
      extra: { rings, chk },
    };
  }
  s.cards.push(
    card(
      36,
      "ink",
      [
        [[[24, WY], [...M]], 0.6, 0.55],
        [[[...M], [400, WY]], 3.35, 0.4],
        ...(f
          ? []
          : [
              [
                [
                  [400, WY],
                  [616, WY],
                ],
                3.95,
                0.6,
              ] as const,
            ]),
      ],
      0.6,
      4.6,
      {
        col: [[3.75, f ? "red" : "green"]],
        tags: [
          ["run", 0.65, 1.0],
          [f ? "c3: no verdict" : "3 results", 3.85, 4.5, f ? 32 : -22],
        ],
      }
    )
  );
  note(s, 0.6, "run arrives", "ink");
  note(s, 1.05, "3 children forked", "dim");
  note(s, 2.0, "1 of 3 done", "amber");
  note(s, 2.6, "2 of 3 done", "amber");
  note(s, 3.1, "3 of 3 done", "ink");
  note(
    s,
    3.75,
    f
      ? "combined output rejected · step failed"
      : "combined output fits · step done",
    f ? "red" : "green"
  );
  return {
    name: kind,
    still: f ? 4 : 2.75,
    timeline: seal(s),
    extra: { rings, chk },
  };
}

/** The solid outcome ring a finished child keeps once its ring has popped. */
function Settled({ x, role }: { x: number; role: CardRole }) {
  const { fade } = usePart();
  return (
    <path
      d={arcPath(x, 150, 20, 0, 2 * Math.PI)}
      fill="none"
      stroke={roleColor(role)}
      strokeWidth={3.5}
      opacity={fade}
    />
  );
}

export const waitChildrenMachine: MachinePartDef<WaitExtra> = {
  part: {
    name: "wait children",
    job: "parks for child tasks",
    aka: "wait_children · fork → children · join",
  },
  family: "vertebrae workflows",
  footprint: "M",
  bb: [180, 110, 270, 180],
  status: { x: 315, y: 322 },
  scenarios: [
    waitStory("all children done"),
    waitStory("combined output rejected"),
    waitStory("child still running"),
  ],
  draw: (t, { rings, chk }) => (
    <>
      <Rail
        points={[
          [24, WY],
          [180, WY],
        ]}
      />
      <Rail
        points={[
          [450, WY],
          [616, WY],
        ]}
      />
      <PartBox x={180} y={110} w={270} h={180} />
      <Hole x={M[0]} y={WY} r={22} />
      <path
        d={CHILD_X.map((x) => `M315 213 L${x} 170`).join(" ")}
        fill="none"
        stroke={roleColor("edge")}
        strokeWidth={2}
      />
      {rings.map(([x, a, b, c]) => (
        <g key={x}>
          <Hole x={x} y={150} r={20} />
          <SvgText
            x={x}
            y={151}
            runs={[[`c${1 + (x - 255) / 60}`, 400, "dim"]]}
            size={18}
            align="center"
          />
          {c ? (
            <Ring x={x} y={150} t={t} from={a} to={b} result={c} r={20} />
          ) : (
            <Spinner x={x} y={150} t={t} from={a} to={b} r={20} />
          )}
          {c && t >= b + 0.45 && <Settled x={x} role={c} />}
        </g>
      ))}
      <CheckFrame x={400} y={WY} t={t} flashes={chk} />
    </>
  ),
};
