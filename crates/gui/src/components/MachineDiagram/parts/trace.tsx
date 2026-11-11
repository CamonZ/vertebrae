/* eslint-disable react-refresh/only-export-components -- part definitions sit beside their renderer */
/**
 * trace · nested timings (catalogue "trace"): nested spans with a cursor.
 * Ported from the gallery artifact
 * (vtb://artifact/9c0496e1-80c3-4d92-b5cb-4444737ac20a) line for line.
 */
import { Bar, PartBox } from "../fixtures";
import { smoothstep } from "../motion";
import { roleColor } from "../palette";
import { note, seal, story } from "../timeline";
import { FadedText } from "./draw";
import type { MachinePartDef, PartScenario } from "./types";

/** One span: `[row, x, start, end, name]`. */
type Span = readonly [number, number, number, number, string];

interface TraceExtra {
  readonly sp: readonly Span[];
  readonly fail: boolean;
  /** Cursor sweep `[from, to]` (the gallery: 0.6 → 3.7 s). */
  readonly cursor: readonly [number, number];
}

const PX = 90;
const FAILED = new Set(["timeout", "query", "request"]);

function traceStory(failed: boolean): PartScenario<TraceExtra> {
  const s = story(5.4);
  const sp: Span[] = [
    [0, 120, 0.6, 3.7, "request"],
    [1, 148, 0.9, 1.9, "auth"],
    [1, 238, 2.0, 3.5, "query"],
    [2, 262, 2.2, 3.0, failed ? "retry" : "db"],
    [3, 292, 2.5, 2.9, failed ? "timeout" : "io"],
  ];
  note(s, 0.6, "recording", "dim");
  note(
    s,
    3.7,
    failed ? "slow · query failed" : "done · 3.1 s",
    failed ? "red" : "green"
  );
  return {
    name: failed ? "slow failure" : "done",
    still: 3,
    timeline: seal(s),
    extra: { sp, fail: failed, cursor: [0.6, 3.7] },
  };
}

function Cursor({
  t,
  cursor,
}: {
  t: number;
  cursor: readonly [number, number];
}) {
  const [from, to] = cursor;
  if (!(t >= from && t < to + 0.1)) return null;
  const x = 120 + (Math.min(t, to) - from) * PX;
  return (
    <line
      x1={x}
      y1={108}
      x2={x}
      y2={282}
      stroke={roleColor("amber")}
      strokeWidth={1.5}
    />
  );
}

function Spans({
  t,
  sp,
  fail,
}: {
  t: number;
  sp: readonly Span[];
  fail: boolean;
}) {
  return (
    <>
      {sp.map(([row, x, a, b, name], i) => {
        if (t < a) return null;
        const y = 120 + row * 34;
        const w = (Math.min(t, b) - a) * PX;
        const failed = fail && FAILED.has(name);
        const role = t < b ? "edge" : failed ? "red" : "ink";
        return (
          <g key={i}>
            <Bar x={x} y={y} w={Math.max(w, 2)} role={role} h={12} />
            {t >= b && (
              <FadedText
                x={x + w + 8}
                y={y + 6}
                runs={[[name, 400, "dim"]]}
                size={18}
                opacity={smoothstep(b, b + 0.2, t)}
              />
            )}
          </g>
        );
      })}
    </>
  );
}

export const traceMachine: MachinePartDef<TraceExtra> = {
  part: {
    name: "trace",
    job: "nested timings",
    aka: "span · profile · request log · timeline",
  },
  family: "observability",
  footprint: "L",
  bb: [90, 92, 460, 210],
  status: { x: 320, y: 334 },
  scenarios: [traceStory(false), traceStory(true)],
  draw: (t, { sp, fail, cursor }) => (
    <>
      <PartBox x={90} y={92} w={460} h={210} />
      <Spans t={t} sp={sp} fail={fail} />
      <Cursor t={t} cursor={cursor} />
    </>
  ),
};
