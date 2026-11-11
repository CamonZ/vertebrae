/* eslint-disable react-refresh/only-export-components -- a part definition with its private mechanism component */
/**
 * task run · one durable run through the steps (catalogue "task run"): step
 * stations by step type with lamps, and a status pill sliding queued →
 * executing → waiting → completed / failed. Ported from the gallery line for
 * line.
 */
import { Lamp, PartBox, Terminal } from "../fixtures";
import { lampAt, type LampStep } from "../geometry";
import { slide, track } from "../motion";
import { roleColor, type CardRole } from "../palette";
import { usePart } from "../partContext";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, note, seal, story } from "../timeline";
import type { MachinePartDef, PartScenario } from "./types";

const STATES = [
  ["queued", 72],
  ["executing", 192],
  ["waiting", 318],
  ["completed", 444],
  ["failed", 564],
] as const;
const STATE_ROLE = ["dim", "ink", "amber", "green", "red"] as const;
const STATE_W = [78, 110, 90, 110, 78] as const;
const X = [110, 300, 490] as const;
const R = 145;

interface TaskRunExtra {
  /** Station labels by step type. */
  readonly lab: readonly [string, string, string];
  /** Status pill position `[at, state index]`. */
  readonly st: readonly (readonly [number, number])[];
  /** One lamp timeline per station. */
  readonly lamps: readonly (readonly LampStep[])[];
  /** When the finish terminal fills. */
  readonly done: number | null;
}

const hop = (a: number, b: number, t0: number) =>
  [
    [
      [X[a], R],
      [X[b], R],
    ],
    t0,
    0.6,
  ] as const;
const enter = [
  [
    [24, R],
    [X[0], R],
  ],
  0.8,
  0.5,
] as const;

function taskRunStory(
  kind: "completes" | "fails at a step" | "parks at a gate"
): PartScenario<TaskRunExtra> {
  const gate = kind === "parks at a gate";
  const f = kind === "fails at a step";
  const s = story(gate ? 6.0 : 5.0);
  const lab = gate
    ? (["llm", "gate", "finish"] as const)
    : (["llm", "execute", "finish"] as const);
  const lamps: LampStep[][] = [[[0, "off"]], [[0, "off"]], [[0, "off"]]];
  if (f) {
    lamps[0].push([0.9, "amber"], [2.0, "red"]);
    s.cards.push(
      card(28, "ink", [enter], 0.8, 3.8, {
        col: [[2.0, "red"]],
        tags: [["run", 0.85, 1.2]],
      })
    );
    note(s, 0.4, "queued", "dim");
    note(s, 0.8, "executing · llm", "ink");
    note(s, 2.0, "failed at llm · reason saved", "red");
    return {
      name: kind,
      still: 2.4,
      timeline: seal(s),
      extra: {
        lab,
        st: [
          [0, 0],
          [0.4, 0],
          [0.8, 1],
          [2.0, 4],
        ],
        lamps,
        done: null,
      },
    };
  }
  if (gate) {
    lamps[0].push([0.9, "amber"], [1.6, "green"]);
    lamps[1].push([2.15, "amber"], [3.7, "green"]);
    s.cards.push(
      card(28, "ink", [enter, hop(0, 1, 1.7), hop(1, 2, 3.8)], 0.8, 4.5, {
        tags: [["run", 0.85, 1.2]],
      })
    );
    note(s, 0.4, "queued", "dim");
    note(s, 0.8, "executing · llm", "ink");
    note(s, 2.15, "waiting · gate", "amber");
    note(s, 3.7, "answered · executing", "ink");
    note(s, 4.3, "completed", "green");
    return {
      name: kind,
      still: 2.8,
      timeline: seal(s),
      extra: {
        lab,
        st: [
          [0, 0],
          [0.4, 0],
          [0.8, 1],
          [2.15, 2],
          [3.7, 1],
          [4.3, 3],
        ],
        lamps,
        done: 4.3,
      },
    };
  }
  lamps[0].push([0.9, "amber"], [1.6, "green"]);
  lamps[1].push([2.3, "amber"], [2.8, "green"]);
  s.cards.push(
    card(28, "ink", [enter, hop(0, 1, 1.7), hop(1, 2, 2.9)], 0.8, 3.5, {
      tags: [["run", 0.85, 1.2]],
    })
  );
  note(s, 0.4, "queued", "dim");
  note(s, 0.8, "executing · llm", "ink");
  note(s, 1.8, "executing · execute", "ink");
  note(s, 3.3, "completed", "green");
  return {
    name: kind,
    still: 2.6,
    timeline: seal(s),
    extra: {
      lab,
      st: [
        [0, 0],
        [0.4, 0],
        [0.8, 1],
        [3.3, 3],
      ],
      lamps,
      done: 3.3,
    },
  };
}

/** The status pill: an outlined capsule that slides between the five state names. */
function StatusPill({ t, st }: { t: number; st: TaskRunExtra["st"] }) {
  const { fade } = usePart();
  const v = track(st, t, slide);
  const i0 = Math.floor(v);
  const i1 = Math.min(4, i0 + 1);
  const u = v - i0;
  const cx = STATES[i0][1] + (STATES[i1][1] - STATES[i0][1]) * u;
  const w = STATE_W[i0] + (STATE_W[i1] - STATE_W[i0]) * u;
  const cur = Math.round(v);
  return (
    <>
      <rect
        x={cx - w / 2}
        y={234}
        width={w}
        height={32}
        rx={16}
        fill="none"
        stroke={roleColor(STATE_ROLE[cur])}
        strokeWidth={2}
        opacity={fade}
      />
      {STATES.map(([name, x], i) => (
        <SvgText
          key={name}
          x={x}
          y={251}
          runs={[
            [name, i === cur ? 600 : 400, i === cur ? STATE_ROLE[i] : "dim"],
          ]}
          size={18}
          align="center"
        />
      ))}
    </>
  );
}

export const taskRunMachine: MachinePartDef<TaskRunExtra> = {
  part: {
    name: "task run",
    job: "one durable run through the steps",
    aka: "TaskRun · start-taskrun · Sacrum",
  },
  family: "vertebrae workflows",
  footprint: "L",
  bb: [50, 105, 520, 80],
  status: { x: 320, y: 330 },
  scenarios: [
    taskRunStory("completes"),
    taskRunStory("fails at a step"),
    taskRunStory("parks at a gate"),
  ],
  draw: (t, { lab, st, lamps, done }) => (
    <>
      <Rail
        points={[
          [24, R],
          [600, R],
        ]}
      />
      {X.map((x, i) => {
        const [role, k] = i < 2 ? lampAt(lamps[i], t) : [null, 0];
        return (
          <g key={x}>
            <PartBox x={x - 50} y={110} w={100} h={70} r={12} />
            <SvgText
              x={x}
              y={170}
              runs={[[lab[i], 400, "dim"]]}
              size={18}
              align="center"
            />
            {i < 2 && (
              <Lamp
                x={x + 36}
                y={124}
                r={7}
                role={role as CardRole | null}
                k={k}
              />
            )}
          </g>
        );
      })}
      <Terminal x={490} y={138} t={t} at={done} role="green" r={12} />
      <StatusPill t={t} st={st} />
    </>
  ),
};
