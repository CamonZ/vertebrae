/**
 * Pure geometry for the shared fixtures: arcs, slot-ring poses, lamp
 * timelines and press lights. Components in fixtures.tsx and Press.tsx draw
 * what these return.
 */
import { pop, smoothstep } from "./motion";
import type { CardRole } from "./palette";

const TAU = 2 * Math.PI;

/** SVG path for a circular arc from angle `a0` to `a1` (radians, clockwise). */
export function arcPath(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number
): string {
  const sweep = Math.min(a1 - a0, TAU);
  if (sweep <= 0) return "";
  const pt = (a: number) =>
    `${round(cx + r * Math.cos(a))} ${round(cy + r * Math.sin(a))}`;
  if (sweep >= TAU - 1e-6) {
    // A closed circle needs two arcs; one arc with equal ends draws nothing.
    return `M${pt(a0)} A${r} ${r} 0 1 1 ${pt(a0 + Math.PI)} A${r} ${r} 0 1 1 ${pt(a0)}`;
  }
  return `M${pt(a0)} A${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${pt(a0 + sweep)}`;
}
const round = (n: number) => Math.round(n * 100) / 100;

/** A lamp timeline entry: `[t, role | "off"]`. */
export type LampStep = readonly [number, CardRole | "off"];

/** Lamp colour and fill (pop spring, capped at 1.1) at `t`. */
export function lampAt(
  steps: readonly LampStep[],
  t: number
): [CardRole | null, number] {
  let role: CardRole | null = null;
  let k = 0;
  for (const [a, c] of steps) {
    if (t < a) continue;
    role = c === "off" ? null : c;
    k = c === "off" ? 0 : Math.min(1.1, pop(t - a));
  }
  return [role, k];
}

export interface RingGeometry {
  readonly radius: number;
  readonly a0: number;
  readonly a1: number;
  readonly role: CardRole;
}

/**
 * A slot ring fills amber from `from` to `to`; with a `result` it then pops
 * in that colour and unwinds over 0.45 s. Null when nothing is drawn.
 */
export function ringGeometry(
  t: number,
  from: number,
  to: number,
  result: CardRole | null,
  r = 24
): RingGeometry | null {
  if (t < from || t > to + 0.45) return null;
  const p = Math.min(1, (t - from) / (to - from));
  const start = -Math.PI / 2;
  if (t < to)
    return {
      radius: r,
      a0: start,
      a1: start + Math.max(0.0087, p * TAU),
      role: "amber",
    };
  if (!result) return null;
  const u = smoothstep(0.1, 0.45, t - to);
  if (u >= 1) return null;
  return {
    radius: r * (1 + 0.14 * (pop(t - to) - smoothstep(0, 0.3, t - to))),
    a0: start + u * TAU,
    a1: start + TAU,
    role: result,
  };
}

/** Number of lights lit at `t` (none after `off`). */
export function litAt(
  times: readonly number[],
  t: number,
  off: number
): number {
  return t >= off ? 0 : times.filter((x) => t >= x).length;
}
