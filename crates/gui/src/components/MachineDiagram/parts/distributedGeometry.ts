import type { CardRole, StateRole } from "../palette";
import type { Point } from "../route";

export type RingEvent = [number, number, StateRole];

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
