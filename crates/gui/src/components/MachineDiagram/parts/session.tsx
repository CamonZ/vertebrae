/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism component */
/**
 * session · lives across turns (catalogue "session"): a dashed frame while no
 * process is live (solid while one is), a pid lamp and a resume id on a
 * dashed control rail. A closed session keeps its resume id and resumes from
 * it; a failed resume loses the history. Ported from the gallery line for
 * line.
 */
import { Bar, Lamp, PartBox } from "../fixtures";
import { pop, smoothstep } from "../motion";
import type { Role, StateRole } from "../palette";
import { roleColor } from "../palette";
import { usePart } from "../partContext";
import { Rail } from "../Rail";
import { card, gateV, note, seal, story } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

interface SessionExtra {
  /** Intervals during which a process is live `[from, to]`. */
  readonly alive: readonly (readonly [number, number])[];
  /** When each process spawns (a halo rings the frame). */
  readonly spawn: readonly number[];
  readonly crash: number | null;
  /** History bars `[appearsAt, width, role]`. */
  readonly bars: readonly (readonly [number, number, Role])[];
  /** The resume fails at this time: its halo is red and the history bars are lost. */
  readonly failedAt: number | null;
}

const Y = 170;

function sessionStory(
  kind: "resumed" | "resume fails" | "crash mid-turn"
): PartScenario<SessionExtra> {
  const f = kind === "resume fails";
  const crashed = kind === "crash mid-turn";
  const s = story(crashed ? 4.6 : 7.4);
  s.gates.push(gateV(220, Y), gateV(220, 245), gateV(420, Y));
  const turn = (
    a: number,
    label: string,
    dies = a + 0.65,
    col: readonly (readonly [number, "red"])[] = []
  ) =>
    card(
      28,
      "amber",
      [
        [
          [
            [24, Y],
            [290, Y],
          ],
          a,
          0.6,
        ],
      ],
      a,
      dies,
      { col, tags: [[label, a + 0.05, a + 0.4]] }
    );
  if (crashed) {
    s.cards.push(turn(0.9, "turn 1", 2.05, [[1.85, "red"]]));
    note(s, 0.6, "spawn", "ink");
    note(s, 1.5, "live · turn 1", "amber");
    note(s, 1.9, "crashed mid-turn", "red");
    note(s, 2.9, "turn 1 never answered", "red");
    return {
      name: kind,
      still: 2.2,
      timeline: seal(s),
      extra: {
        alive: [[0.6, 1.9]],
        spawn: [0.6],
        crash: 1.9,
        bars: [[1.55, 110, "amber"]],
        failedAt: null,
      },
    };
  }
  s.cards.push(turn(0.9, "turn 1"));
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [330, Y],
            [616, Y],
          ],
          2.0,
          0.6,
        ],
      ],
      2.0,
      2.65
    )
  );
  s.cards.push(
    card(
      18,
      "edge",
      [
        [
          [
            [300, 245],
            [120, 245],
          ],
          3.2,
          0.6,
        ],
        [
          [
            [120, 245],
            [300, 245],
          ],
          4.65,
          0.6,
        ],
      ],
      3.2,
      5.3,
      { tags: [["resume id", 3.3, 4.4, -20]] }
    )
  );
  s.cards.push(turn(4.5, "turn 2"));
  const bars: [number, number, Role][] = [
    [1.55, 110, "amber"],
    [2.0, 150, "ink"],
  ];
  if (!f) bars.push([5.2, 90, "amber"]);
  note(s, 0.6, "spawn", "ink");
  note(s, 1.5, "live · turn 1", "amber");
  note(s, 2.6, "idle · kept", "amber");
  note(s, 3.1, "closed · resume id kept", "dim");
  note(s, 4.5, "turn 2", "ink");
  note(
    s,
    5.1,
    f ? "resume failed · history lost" : "resumed",
    f ? "red" : "green"
  );
  return {
    name: kind,
    still: 2,
    timeline: seal(s),
    extra: {
      alive: [
        [0.6, 3.1],
        [5.1, f ? 5.6 : 9],
      ],
      spawn: [0.6, 5.1],
      crash: null,
      bars,
      failedAt: f ? 5.1 : null,
    },
  };
}

/** A halo that rings the frame for 0.5 s after a process spawns or crashes. */
function Halo({ t, at, role }: { t: number; at: number; role: StateRole }) {
  const { fade } = usePart();
  const d = t - at;
  if (d < 0 || d >= 0.5) return null;
  const k = 1 - smoothstep(0, 0.5, d);
  return (
    <rect
      className="md-halo"
      x={220 - 6 * (1 - k)}
      y={100 - 6 * (1 - k)}
      width={212 - 12 * k + 12}
      height={202 - 12 * k + 12}
      rx={20}
      fill="none"
      stroke={roleColor(role)}
      strokeWidth={2 + 3 * k}
      opacity={k * fade}
    />
  );
}

export const sessionMachine: MachinePartDef<SessionExtra> = {
  part: {
    name: "session",
    job: "lives across turns",
    aka: "connection · agent process · socket · login",
  },
  family: "topology and lifecycle",
  footprint: "S",
  bb: [220, 100, 200, 190],
  status: { x: 320, y: 322 },
  scenarios: [
    sessionStory("resumed"),
    sessionStory("resume fails"),
    sessionStory("crash mid-turn"),
  ],
  draw: (t, { alive: spans, spawn, crash, bars, failedAt }) => {
    let alive = 0;
    for (const [a, b] of spans)
      alive = Math.max(
        alive,
        smoothstep(a, a + 0.2, t) * (1 - smoothstep(b, b + 0.25, t))
      );
    const dead = crash != null && t >= crash;
    const lost = failedAt != null ? smoothstep(failedAt, failedAt + 0.3, t) : 0;
    return (
      <>
        <Rail
          points={[
            [24, Y],
            [220, Y],
          ]}
        />
        <Rail
          points={[
            [120, 245],
            [220, 245],
          ]}
          dashed
          dash="4 6"
        />
        <Rail
          points={[
            [420, Y],
            [616, Y],
          ]}
        />
        {/* dashed while no process is live, solid while one is */}
        <PartBox x={220} y={100} w={200} h={190} dashed opacity={1 - alive} />
        <PartBox x={220} y={100} w={200} h={190} noFill opacity={alive} />
        {[...spawn, ...(crash != null ? [crash] : [])].map((at) => (
          <Halo
            key={at}
            t={t}
            at={at}
            role={at === failedAt || at === crash ? "red" : "amber"}
          />
        ))}
        <Lamp
          x={400}
          y={120}
          r={7}
          role={alive > 0 ? "green" : dead ? "red" : null}
          k={alive > 0 ? alive : dead ? 1 : 0}
        />
        {bars.map(([a, w, role], i) =>
          t >= a ? (
            <g key={i} opacity={1 - lost}>
              <Bar x={244} y={128 + i * 16} w={w} role={role} k={pop(t - a)} />
            </g>
          ) : null
        )}
      </>
    );
  },
};
