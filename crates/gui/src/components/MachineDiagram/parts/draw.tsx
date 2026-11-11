/**
 * Small drawing helpers shared by the part mechanisms, matching the gallery's
 * plateLine, guide strokes and outline rects. Colours are palette roles only.
 */
import type { Point } from "../route";
import { roleColor, type Role } from "../palette";

/** A plate stem or arm: a round-capped plate-coloured line (gallery `plateLine`). */
export function PlateLine({
  x1,
  y1,
  x2,
  y2,
  w = 5,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w?: number;
}) {
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={roleColor("plate")}
      strokeWidth={w}
      strokeLinecap="round"
    />
  );
}

/** Open polylines (guides, dividers) stroked in one role. */
export function Strokes({
  lines,
  role = "edge",
  w = 3,
}: {
  lines: readonly (readonly Point[])[];
  role?: Role;
  w?: number;
}) {
  const d = lines
    .map((pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" "))
    .join(" ");
  return (
    <path
      d={d}
      stroke={roleColor(role)}
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  );
}

/** A stroke-only rounded rectangle (screen insets, buttons, regions). */
export function Outline({
  x,
  y,
  w,
  h,
  r,
  role = "edge",
  strokeWidth = 2,
  dash,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  role?: Role;
  strokeWidth?: number;
  dash?: string;
}) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={r}
      fill="none"
      stroke={roleColor(role)}
      strokeWidth={strokeWidth}
      strokeDasharray={dash}
    />
  );
}
