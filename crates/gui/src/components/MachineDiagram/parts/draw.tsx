/**
 * Small drawing helpers shared by the part mechanisms, matching the gallery's
 * plateLine, guide strokes and outline rects. Colours are palette roles only.
 */
import type { Point } from "../route";
import { roleColor, type Role } from "../palette";
import { usePart } from "../partContext";
import { Glyph, SvgText, type SvgTextProps } from "../SvgText";

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

/** The blinking prompt caret of a source-like box (gallery `caret`). */
export function Caret({ x, y, t }: { x: number; y: number; t: number }) {
  return (
    <>
      <Glyph x={x} y={y} text=">" size={26} role="ink" />
      {Math.floor(t * 4) % 2 === 0 && (
        <rect
          x={x + 12}
          y={y + 6}
          width={14}
          height={3}
          fill={roleColor("ink")}
        />
      )}
    </>
  );
}

/** A filled and/or stroked circle that follows the loop fade (event dots, pointers). */
export function Disc({
  x,
  y,
  r,
  fill,
  stroke,
  strokeWidth = 2,
}: {
  x: number;
  y: number;
  r: number;
  fill?: Role;
  stroke?: Role;
  strokeWidth?: number;
}) {
  const { fade } = usePart();
  if (r <= 0) return null;
  return (
    <circle
      cx={x}
      cy={y}
      r={r}
      fill={fill ? roleColor(fill) : "none"}
      stroke={stroke ? roleColor(stroke) : undefined}
      strokeWidth={stroke ? strokeWidth : undefined}
      opacity={fade < 1 ? fade : undefined}
    />
  );
}

/** Text that follows the loop fade (gallery `text(..., alpha * K.fade)`). */
export function FadedText({ opacity = 1, ...rest }: SvgTextProps) {
  const { fade } = usePart();
  return <SvgText {...rest} opacity={opacity * fade} />;
}

/** A plain filled rounded rectangle in one role (tracks, bars, plates). */
export function Slab({
  x,
  y,
  w,
  h,
  r = 0,
  role,
  stroke,
  strokeWidth = 1.5,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number;
  role: Role;
  stroke?: Role;
  strokeWidth?: number;
}) {
  if (w <= 0 || h <= 0) return null;
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={Math.min(r, w / 2, h / 2)}
      fill={roleColor(role)}
      stroke={stroke ? roleColor(stroke) : undefined}
      strokeWidth={stroke ? strokeWidth : undefined}
    />
  );
}
