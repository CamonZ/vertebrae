/* eslint-disable react-refresh/only-export-components -- part definitions sit beside their renderer */
/**
 * event rail · ordered facts (catalogue "event rail"): a long rail of event
 * dots with a reader cursor that freezes and replays on resume. Ported from
 * the gallery artifact (vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a)
 * line for line.
 */
import { Burst, Terminal } from "../fixtures";
import { clamp, pop } from "../motion";
import { roleColor, type CardRole, type StateRole } from "../palette";
import { RAIL_Y as Y } from "../MachinePart";
import { Rail } from "../Rail";
import { SvgText } from "../SvgText";
import { card, note, seal, story } from "../timeline";
import { Disc, FadedText } from "./draw";
import { usePart } from "../partContext";
import type { MachinePartDef, PartScenario } from "./types";

type Dot = readonly [at: number, kind: "delta" | "msg" | "ring", end?: number];

interface Resume {
  /** When each fact is written / when the reader reads it. */
  readonly arr: readonly number[];
  readonly rd: readonly number[];
  /** Disconnect window `[from, to]`. */
  readonly cut: readonly [number, number];
}

interface EventRailExtra {
  readonly dots: readonly Dot[];
  /** When the turn outcome lands at the terminal (null keeps it empty). */
  readonly done: number | null;
  readonly fail: boolean;
  readonly resume: Resume | null;
}

const X = (i: number) => 100 + 36 * i;

function turnStory(failed: boolean): PartScenario<EventRailExtra> {
  const s = story(5.2);
  const dots: Dot[] = [
    [0.6, "delta"],
    [1.0, "ring", 1.9],
    [1.35, "delta"],
    [1.7, "ring", 2.4],
    [2.6, "delta"],
    [3.15, "msg"],
  ];
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [80, Y],
            [588, Y],
          ],
          2.9,
          0.7,
        ],
      ],
      2.9,
      3.65
    )
  );
  note(s, 0.6, "text delta", "dim");
  note(s, 1.0, "tool started", "amber");
  note(s, 1.9, "tool done", "green");
  note(s, 2.4, failed ? "tool failed" : "tool done", failed ? "red" : "green");
  note(s, 3.15, "message", "ink");
  note(
    s,
    3.6,
    failed ? "turn failed" : "turn complete",
    failed ? "red" : "green"
  );
  s.notes[0] = [0, "nothing yet", "dim"];
  return {
    name: failed ? "tool fails" : "turn complete",
    still: 3.3,
    timeline: seal(s),
    extra: { dots, done: 3.6, fail: failed, resume: null },
  };
}

function resumeStory(): PartScenario<EventRailExtra> {
  const s = story(6.0);
  s.cards.push(
    card(
      28,
      "ink",
      [
        [
          [
            [80, Y],
            [588, Y],
          ],
          4.4,
          0.7,
        ],
      ],
      4.4,
      5.15
    )
  );
  note(s, 0.5, "live", "ink");
  note(s, 1.5, "disconnected", "red");
  note(s, 2.9, "reconnect · from #4", "amber");
  note(s, 3.6, "caught up", "green");
  note(s, 4.5, "message", "ink");
  note(s, 5.1, "turn complete", "green");
  s.notes[0] = [0, "nothing yet", "dim"];
  return {
    name: "disconnect · resume",
    still: 2.45,
    timeline: seal(s),
    extra: {
      dots: [],
      done: 5.1,
      fail: false,
      resume: {
        arr: [0.5, 0.9, 1.3, 1.7, 2.1, 2.5, 3.9, 4.2],
        rd: [0.5, 0.9, 1.3, 3.1, 3.3, 3.5, 3.9, 4.2],
        cut: [1.5, 2.9],
      },
    },
  };
}

function Facts({
  t,
  dots,
  fail,
}: {
  t: number;
  dots: readonly Dot[];
  fail: boolean;
}) {
  return (
    <>
      {dots.map(([a, kind, end], i) => {
        if (t < a) return null;
        const x = X(i);
        const k = pop(t - a);
        if (kind === "delta")
          return <Disc key={i} x={x} y={Y} r={6 * k} fill="edge" />;
        if (kind === "msg")
          return <Disc key={i} x={x} y={Y} r={10 * k} fill="ink" />;
        const done = t >= (end ?? Infinity);
        const role: CardRole = done
          ? fail && i === 3
            ? "red"
            : "green"
          : "amber";
        return (
          <g key={i}>
            <Disc x={x} y={Y} r={11 * k} stroke={role} strokeWidth={3} />
            {done && (
              <Disc x={x} y={Y} r={6 * pop(t - (end ?? 0))} fill={role} />
            )}
          </g>
        );
      })}
    </>
  );
}

function Reader({ t, resume }: { t: number; resume: Resume }) {
  const { fade } = usePart();
  const { arr, rd, cut } = resume;
  let n = -1;
  for (let i = 0; i < rd.length; i++) if (t >= rd[i]) n = i;
  let x = n < 0 ? X(0) - 36 : X(n);
  if (n >= 0) {
    const pv = n > 0 ? X(n - 1) : X(0) - 36;
    x = pv + (x - pv) * Math.min(1, clamp(t - rd[n]));
  }
  const off = t >= cut[0] && t < cut[1];
  const role: StateRole = off ? "red" : "ink";
  return (
    <>
      {arr.map((a, i) => {
        if (t < a) return null;
        const read = t >= rd[i];
        const k = pop(t - a);
        return (
          <g key={i}>
            {read ? (
              <Disc x={X(i)} y={Y} r={6 * k} fill="edge" />
            ) : (
              <Disc x={X(i)} y={Y} r={6 * k} fill="hole" stroke="edge" />
            )}
            {read && rd[i] > a && (
              <Burst
                x={X(i)}
                y={Y}
                t={t}
                at={rd[i]}
                role="amber"
                r0={6}
                r1={20}
              />
            )}
          </g>
        );
      })}
      <path
        d={`M${x} ${Y + 16} L${x - 7} ${Y + 28} L${x + 7} ${Y + 28} Z`}
        fill={roleColor(role)}
        opacity={fade < 1 ? fade : undefined}
      />
      <FadedText
        x={x}
        y={Y + 48}
        runs={[["reader", 400, off ? "red" : "dim"]]}
        size={18}
        align="center"
      />
    </>
  );
}

export const eventRailMachine: MachinePartDef<EventRailExtra> = {
  part: {
    name: "event rail",
    job: "ordered facts",
    aka: "event stream · log tail · SSE · websocket",
  },
  family: "messaging and flow control",
  footprint: "L",
  bb: [40, 170, 570, 60],
  status: { x: 200, y: 150, align: "left" },
  scenarios: [turnStory(false), turnStory(true), resumeStory()],
  draw: (t, { dots, done, fail, resume }) => (
    <>
      <Rail
        points={[
          [60, Y],
          [574, Y],
        ]}
      />
      <SvgText x={60} y={150} runs={[["events", 600, "ink"]]} size={22} />
      {resume ? (
        <Reader t={t} resume={resume} />
      ) : (
        <Facts t={t} dots={dots} fail={fail} />
      )}
      <Terminal x={590} y={Y} t={t} at={done} role={fail ? "red" : "green"} />
    </>
  ),
};
