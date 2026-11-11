/**
 * Shared fixtures from the reference language: lamps, slot rings, spinners,
 * bursts, terminals, bars, holes and part frames. Each is a pure function of
 * its props (including `t` where it moves); none schedules animation.
 */
import { arcPath, ringGeometry } from "./geometry";
import { pop, smoothstep } from "./motion";
import { roleColor, type Role, type StateRole } from "./palette";
import { usePart } from "./partContext";

/* ---------- part frame and holes ---------- */

export interface PartBoxProps {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner radius: 18, or 12 for small parts (VL-01). */
  r?: number;
  /** Dashed frame: a region or no live instance. */
  dashed?: boolean;
  noFill?: boolean;
  opacity?: number;
}

export function PartBox({
  x,
  y,
  w,
  h,
  r = 18,
  dashed,
  noFill,
  opacity = 1,
}: PartBoxProps) {
  const { removed } = usePart();
  return (
    <g className="md-box">
      {!noFill && (
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={r}
          fill={roleColor("fill")}
        />
      )}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={r}
        fill="none"
        stroke={roleColor("edge")}
        strokeWidth={2}
        strokeDasharray={dashed || removed ? "6 6" : undefined}
        opacity={opacity < 1 ? opacity : undefined}
      />
    </g>
  );
}

export function Hole({ x, y, r = 24 }: { x: number; y: number; r?: number }) {
  return (
    <circle
      cx={x}
      cy={y}
      r={r}
      fill={roleColor("hole")}
      stroke={roleColor("rail")}
      strokeWidth={2}
    />
  );
}

/* ---------- lamps ---------- */

export interface LampProps {
  x: number;
  y: number;
  r: number;
  role: StateRole | null;
  /** Fill amount 0..1.1 (pop spring). */
  k: number;
}

export function Lamp({ x, y, r, role, k }: LampProps) {
  const { fade } = usePart();
  return (
    <g className="md-lamp">
      <circle
        cx={x}
        cy={y}
        r={r}
        fill={roleColor("hole")}
        stroke={roleColor("edge")}
        strokeWidth={1.5}
      />
      {k > 0 && role && (
        <circle
          cx={x}
          cy={y}
          r={Math.max(0, r - 2.5) * k}
          fill={roleColor(role)}
          opacity={fade}
        />
      )}
    </g>
  );
}

/* ---------- slot ring ---------- */

export interface RingProps {
  x: number;
  y: number;
  t: number;
  from: number;
  to: number;
  result?: StateRole | null;
  r?: number;
}

export function Ring({ x, y, t, from, to, result = null, r = 24 }: RingProps) {
  const { fade } = usePart();
  const g = ringGeometry(t, from, to, result, r);
  if (!g) return null;
  return (
    <path
      className="md-ring"
      d={arcPath(x, y, g.radius, g.a0, g.a1)}
      fill="none"
      stroke={roleColor(g.role)}
      strokeWidth={3.5}
      strokeLinecap="round"
      opacity={fade}
    />
  );
}

/* ---------- spinner ---------- */

/** Spinner rotation speed in rad/s. */
export const SPINNER_SPEED = 4.2;

export interface SpinnerProps {
  x: number;
  y: number;
  t: number;
  from: number;
  to: number;
  r?: number;
}

/** An amber waiting arc that turns at 4.2 rad/s between `from` and `to`. */
export function Spinner({ x, y, t, from, to, r = 24 }: SpinnerProps) {
  const { fade } = usePart();
  if (t < from || t > to) return null;
  const k = smoothstep(from, from + 0.2, t) * (1 - smoothstep(to - 0.2, to, t));
  const s = (t - from) * SPINNER_SPEED;
  return (
    <path
      className="md-spinner"
      d={arcPath(x, y, r, s, s + 1.3)}
      fill="none"
      stroke={roleColor("amber")}
      strokeWidth={3.5}
      strokeLinecap="round"
      opacity={k * fade}
    />
  );
}

/* ---------- burst and terminal ---------- */

export interface BurstProps {
  x: number;
  y: number;
  t: number;
  at: number;
  role: StateRole;
  r0?: number;
  r1?: number;
}

/** An expanding ring for 0.8 s after `at`. */
export function Burst({ x, y, t, at, role, r0 = 14, r1 = 56 }: BurstProps) {
  const { fade } = usePart();
  const d = t - at;
  if (d <= 0 || d > 0.8) return null;
  return (
    <circle
      className="md-burst"
      cx={x}
      cy={y}
      r={r0 + (r1 - r0) * smoothstep(0, 0.8, d)}
      fill="none"
      stroke={roleColor(role)}
      strokeWidth={2}
      opacity={(1 - d / 0.8) * fade}
    />
  );
}

export interface TerminalProps {
  x: number;
  y: number;
  t: number;
  /** When the outcome lands; null keeps the terminal empty. */
  at: number | null;
  role: StateRole;
  r?: number;
}

/** End of a rail: fills with the outcome colour and bursts. */
export function Terminal({ x, y, t, at, role, r = 14 }: TerminalProps) {
  const { fade } = usePart();
  const landed = at != null && t >= at;
  const k = landed ? Math.min(pop(t - at), 1.15) * fade : 0;
  return (
    <g className="md-terminal">
      <circle
        cx={x}
        cy={y}
        r={r}
        fill={roleColor("hole")}
        stroke={roleColor("edge")}
        strokeWidth={2}
      />
      {landed && (
        <>
          <circle
            cx={x}
            cy={y}
            r={Math.max(0, (r - 3) * k)}
            fill={roleColor(role)}
          />
          <Burst
            x={x}
            y={y}
            t={t}
            at={at + 0.1}
            role={role}
            r0={r}
            r1={r + 50}
          />
        </>
      )}
    </g>
  );
}

/* ---------- bars ---------- */

export interface BarProps {
  x: number;
  y: number;
  w: number;
  role: Role;
  /** Grown fraction (pop spring); bars spring in from the left. */
  k?: number;
  h?: number;
  /** Static bars ignore the loop fade. */
  still?: boolean;
}

export function Bar({ x, y, w, role, k = 1, h = 7, still }: BarProps) {
  const { fade } = usePart();
  if (k <= 0 || w * k < 0.5) return null;
  return (
    <rect
      className="md-bar"
      x={x}
      y={y}
      width={w * k}
      height={h}
      rx={h / 2}
      fill={roleColor(role)}
      opacity={still || fade >= 1 ? undefined : fade}
    />
  );
}
