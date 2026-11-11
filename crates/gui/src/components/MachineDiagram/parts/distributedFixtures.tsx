/* eslint-disable react-refresh/only-export-components -- typed geometry and fixtures share one responsibility */
/** Fixtures local to distributed-system mechanisms; motion comes from the core. */
import { Burst, Lamp } from "../fixtures";
import { arcPath, lampAt, type LampStep } from "../geometry";
import { clamp, pop, smoothstep, track, valueAt } from "../motion";
import { roleColor, type CardRole, type StateRole } from "../palette";
import { usePart } from "../partContext";
import type { Point } from "../route";
import { StatusLine } from "../StatusLine";
import { statusAt, type StatusNote } from "../timeline";
import { FadedText } from "./draw";
export type RingEvent = [number, number, StateRole];
export function NodeLamp({
  x,
  y,
  r,
  steps,
  t,
}: {
  x: number;
  y: number;
  r: number;
  steps: readonly LampStep[];
  t: number;
}) {
  const [role, k] = lampAt(steps, t);
  return <Lamp x={x} y={y} r={r} role={role} k={k} />;
}
export function Readout({
  steps,
  t,
  x,
  y,
  size = 18,
  align = "left",
}: {
  steps: readonly StatusNote[];
  t: number;
  x: number;
  y: number;
  size?: number;
  align?: "left" | "right" | "center";
}) {
  return (
    <StatusLine
      status={statusAt(steps, t)}
      x={x}
      y={y}
      size={size}
      align={align}
    />
  );
}
export function Halo({
  x,
  y,
  r,
  steps,
  t,
}: {
  x: number;
  y: number;
  r: number;
  steps: readonly (readonly [number, number])[];
  t: number;
}) {
  const { fade } = usePart();
  const k = track(steps, t, clamp);
  return k > 0.02 ? (
    <circle
      cx={x}
      cy={y}
      r={r + 9}
      fill="none"
      stroke={roleColor("ink")}
      strokeWidth={3}
      opacity={Math.min(1, k) * fade}
    />
  ) : null;
}
export function Cut({
  x1,
  y1,
  x2,
  y2,
  at,
  t,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  at: number | null;
  t: number;
}) {
  const { fade } = usePart();
  if (at == null || t < at) return null;
  const k = smoothstep(at, at + 0.35, t);
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x1 + (x2 - x1) * k}
      y2={y1 + (y2 - y1) * k}
      stroke={roleColor("edge")}
      strokeWidth={2.5}
      strokeDasharray="9 7"
      opacity={fade}
    />
  );
}
export function Fuse({
  x,
  y,
  r,
  beats,
  timeout,
  t,
  start = 0,
}: {
  x: number;
  y: number;
  r: number;
  beats: readonly number[];
  timeout: number;
  t: number;
  start?: number;
}) {
  const { fade } = usePart();
  let last = start;
  for (const b of beats) if (t >= b) last = b;
  const p = Math.min(1, (t - last) / timeout);
  return (
    <>
      <path
        d={arcPath(
          x,
          y,
          r,
          -Math.PI / 2,
          -Math.PI / 2 + Math.max(0.01, p) * 2 * Math.PI
        )}
        fill="none"
        stroke={roleColor(p >= 1 ? "red" : "amber")}
        strokeWidth={3.5}
        strokeLinecap="round"
        opacity={fade}
      />
      {p >= 1 && (
        <Burst
          x={x}
          y={y}
          t={t}
          at={last + timeout}
          role="red"
          r0={r}
          r1={r + 40}
        />
      )}
    </>
  );
}
export function onCircle(cx: number, cy: number, r: number, a: number): Point {
  return [
    cx + r * Math.sin((a * Math.PI) / 180),
    cy - r * Math.cos((a * Math.PI) / 180),
  ];
}
export function arcPoints(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  n = 28
): Point[] {
  return Array.from({ length: n + 1 }, (_, i) =>
    onCircle(cx, cy, r, a0 + ((a1 - a0) * i) / n)
  );
}
export interface TileSpec {
  x: number;
  y: number;
  s: string;
  at: number;
  col: [number, CardRole][];
  w?: number;
  gone?: number;
}
export function tileSpec(
  x: number,
  y: number,
  s: string,
  at = -1,
  cl: [number, CardRole][] = [],
  o: { w?: number; gone?: number } = {}
): TileSpec {
  return { x, y, s, at, col: [[-1e9, "edge"], ...cl], ...o };
}
export function Tiles({ list, t }: { list: readonly TileSpec[]; t: number }) {
  const { fade } = usePart();
  return (
    <>
      {list.map((q, i) => {
        if (q.at >= 0 && t < q.at) return null;
        const a = q.gone == null ? 1 : 1 - smoothstep(q.gone, q.gone + 0.3, t),
          k = q.at >= 0 ? pop(t - q.at) : 1;
        if (k <= 0 || a <= 0) return null;
        const role = valueAt(q.col, t),
          w = q.w ?? 36;
        return (
          <g key={`${q.s}-${q.at}-${i}`}>
            <rect
              x={-w / 2}
              y={-14}
              width={w}
              height={28}
              rx={5}
              transform={`translate(${q.x} ${q.y}) scale(${k})`}
              fill={roleColor("hole")}
              stroke={roleColor(role)}
              strokeWidth={2}
              opacity={a * fade}
            />
            {q.s && k > 0.6 && (
              <FadedText
                x={q.x}
                y={q.y + 1}
                runs={[[q.s, 600, role === "edge" ? "dim" : role]]}
                size={18}
                align="center"
                opacity={a}
              />
            )}
          </g>
        );
      })}
    </>
  );
}
