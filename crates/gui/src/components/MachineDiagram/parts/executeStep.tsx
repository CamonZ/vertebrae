/**
 * execute step · runs a Rhai script (catalogue "execute step"): a stamp on the
 * context card, with dashed host stubs up to tasks, artifacts and cmd. Ported
 * from the gallery line for line.
 */
import { Burst, PartBox } from "../fixtures";
import { RAIL_Y as Y } from "../MachinePart";
import { held } from "../motion";
import { roleColor } from "../palette";
import { Rail } from "../Rail";
import { card, dot, gateV, note, seal, story } from "../timeline";
import { HostStub, PlateLine, Wash } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

interface ExecuteExtra {
  /** When the stamp comes down. */
  readonly st: number;
  /** A script error bursts at this time. */
  readonly crash: number | null;
}

function executeStory(
  kind: "transforms" | "script error" | "calls the host"
): PartScenario<ExecuteExtra> {
  const host = kind === "calls the host";
  const f = kind === "script error";
  const s = story(host ? 5.4 : 4.2);
  const st = host ? 3.2 : 1.3;
  s.gates.push(gateV(200, Y), gateV(460, Y));
  s.cards.push(
    card(
      36,
      "ink",
      [
        [
          [
            [24, Y],
            [330, Y],
          ],
          0.6,
          0.6,
        ],
      ],
      0.6,
      st + 0.12,
      { tags: [["context", 0.65, 1.0]] }
    )
  );
  if (host) {
    s.cards.push(
      dot(
        [
          [350, 176],
          [350, 100],
        ],
        1.3,
        0.35,
        "amber"
      )
    );
    s.cards.push(
      dot(
        [
          [350, 100],
          [350, 176],
        ],
        1.75,
        0.35
      )
    );
    s.cards.push(
      dot(
        [
          [440, 176],
          [440, 100],
        ],
        2.2,
        0.35,
        "amber"
      )
    );
    s.cards.push(
      dot(
        [
          [440, 100],
          [440, 176],
        ],
        2.65,
        0.35
      )
    );
    note(s, 0.6, "context in", "ink");
    note(s, 1.3, "vtb::artifacts · read", "amber");
    note(s, 2.2, "vtb::cmd · run", "amber");
  } else note(s, 0.6, "context in", "ink");
  if (f) {
    note(s, st, "running script", "dim");
    note(s, st + 0.15, "script error · step failed", "red");
    s.cards.push(
      card(
        36,
        "red",
        [
          [
            [
              [330, Y],
              [330, Y],
            ],
            st + 0.1,
            0.05,
          ],
        ],
        st + 0.1,
        st + 1.4,
        { tags: [["runtime error", st + 0.3, st + 1.3, 32]] }
      )
    );
    return {
      name: kind,
      still: 1.9,
      timeline: seal(s),
      extra: { st, crash: st + 0.15 },
    };
  }
  s.cards.push(
    card(
      18,
      "ink",
      [
        [
          [
            [330, Y],
            [616, Y],
          ],
          st + 0.2,
          0.6,
        ],
      ],
      st + 0.12,
      st + 0.9,
      {
        h: 28,
        col: [[st + 0.45, "green"]],
        tags: [["json", st + 0.35, st + 0.85, -26]],
      }
    )
  );
  note(s, st, "running script", "dim");
  note(s, st + 0.45, "output valid · step done", "green");
  return {
    name: kind,
    still: host ? 1.5 : 1.6,
    timeline: seal(s),
    extra: { st, crash: null },
  };
}

export const executeStepMachine: MachinePartDef<ExecuteExtra> = {
  part: {
    name: "execute step",
    job: "runs a Rhai script",
    aka: "execute · Rhai · vtb:: host functions",
  },
  family: "vertebrae workflows",
  footprint: "M",
  bb: [200, 140, 260, 120],
  status: { x: 330, y: 300 },
  scenarios: [
    executeStory("transforms"),
    executeStory("script error"),
    executeStory("calls the host"),
  ],
  draw: (t, { st, crash }) => {
    const k = held(t, st, st + 0.25);
    return (
      <>
        <Rail
          points={[
            [24, Y],
            [200, Y],
          ]}
        />
        <Rail
          points={[
            [460, Y],
            [616, Y],
          ]}
        />
        <HostStub x={250} y0={140} y1={96} label="tasks" />
        <HostStub x={350} y0={140} y1={96} label="artifacts" />
        <HostStub x={440} y0={140} y1={96} label="cmd" />
        <PartBox x={200} y={140} w={260} h={120} />
        <rect
          x={306}
          y={148}
          width={48}
          height={8}
          rx={3}
          fill={roleColor("edge")}
        />
        <PlateLine x1={330} y1={156} x2={330} y2={164 + 8 * k} />
        <rect
          x={314}
          y={162 + 8 * k}
          width={32}
          height={8}
          fill={roleColor("plate")}
        />
        {k > 0 && (
          <Wash
            x={308}
            y={Y - 18}
            w={44}
            h={36}
            role="amber"
            alpha={0.22 * k}
          />
        )}
        {crash != null && (
          <Burst x={330} y={Y} t={t} at={crash} role="red" r0={24} r1={90} />
        )}
      </>
    );
  },
};
