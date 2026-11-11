/**
 * Small drawing helpers shared by the part mechanisms, matching the gallery's
 * plateLine, guide strokes and outline rects. Colours are palette roles only.
 */
import type { Point } from "../route";
import { Rail } from "../Rail";
import { roleColor, type CardRole, type Role } from "../palette";
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

/** A stub to a host function: a dashed reference rail from the box up to a label (gallery `hostStub`). */
export function HostStub({
  x,
  y0,
  y1,
  label,
}: {
  x: number;
  y0: number;
  y1: number;
  label: string;
}) {
  return (
    <>
      <Rail
        points={[
          [x, y0],
          [x, y1],
        ]}
        dashed
        dash="3 6"
      />
      <SvgText
        x={x}
        y={y1 - 14}
        runs={[[label, 400, "dim"]]}
        size={18}
        align="center"
      />
    </>
  );
}

/** A dashed schema check frame on a rail; each `[at, role]` flashes it for 0.6 s (gallery `checkFrame`). */
export function CheckFrame({
  x,
  y,
  t,
  flashes,
}: {
  x: number;
  y: number;
  t: number;
  flashes: readonly (readonly [number, CardRole])[];
}) {
  let role: CardRole = "edge";
  for (const [a, c] of flashes) if (t >= a && t < a + 0.6) role = c;
  return (
    <rect
      x={x - 22}
      y={y - 14}
      width={44}
      height={28}
      rx={5}
      fill="none"
      stroke={roleColor(role)}
      strokeWidth={2}
      strokeDasharray="5 4"
    />
  );
}

/** A rule tile: a small outlined plaque that pops in at `k` (gallery `tile`). */
export function Tile({
  x,
  y,
  label,
  role,
  k = 1,
  w = 36,
  alpha = 1,
  dash,
}: {
  x: number;
  y: number;
  label: string;
  role: CardRole;
  k?: number;
  w?: number;
  alpha?: number;
  dash?: boolean;
}) {
  const { fade } = usePart();
  const a = fade * alpha;
  if (k <= 0 || a <= 0) return null;
  return (
    <g className="md-tile">
      <g
        transform={`translate(${x} ${y}) scale(${k})`}
        opacity={a < 1 ? a : undefined}
      >
        <rect
          x={-w / 2}
          y={-14}
          width={w}
          height={28}
          rx={5}
          fill={roleColor("hole")}
          stroke={roleColor(role)}
          strokeWidth={2}
          strokeDasharray={dash ? "4 4" : undefined}
        />
      </g>
      {label && k > 0.6 && (
        <SvgText
          x={x}
          y={y + 1}
          runs={[[label, 600, role === "edge" ? "dim" : role]]}
          size={18}
          align="center"
          opacity={a}
        />
      )}
    </g>
  );
}

/** A translucent state-colour wash that follows the loop fade (clamp glows). */
export function Wash({
  x,
  y,
  w,
  h,
  role,
  alpha,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  role: Role;
  alpha: number;
}) {
  const { fade } = usePart();
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      fill={roleColor(role)}
      opacity={alpha * fade}
    />
  );
}
