/**
 * Shared fixtures of the event-sourcing family (gallery "event sourcing:
 * shared fixtures"): an event tile (an outlined slot with its version or
 * payload, popped in when written), a list of tiles whose colours change over
 * time, and the pointer triangle used for heads, playheads and offsets.
 */
import { pop, smoothstep, valueAt } from "../motion";
import { roleColor, type CardRole, type Role } from "../palette";
import { usePart } from "../partContext";
import { StatusLine } from "../StatusLine";
import { SvgText } from "../SvgText";
import { statusAt, type StatusNote } from "../timeline";

/** One tile: where it sits, its text, when it appears and how its colour moves. */
export interface TileSpec {
  readonly x: number;
  readonly y: number;
  readonly s: string;
  /** Pops in at this time; `-1` is a tile that was already written. */
  readonly at: number;
  /** `[[time, role], ...]`; the first entry (edge) is the resting outline. */
  readonly col: [number, CardRole][];
  readonly w?: number;
  /** Fades out from this time. */
  gone?: number;
  /** Dims and turns dashed from this time (an event the replay never reaches). */
  dimAt?: number;
}

/** Build a tile (gallery `TL`). */
export function TL(
  x: number,
  y: number,
  s: string,
  at = -1,
  cl: [number, CardRole][] = [],
  o: { w?: number } = {}
): TileSpec {
  return { x, y, s, at, col: [[-1e9, "edge"], ...cl], ...o };
}

interface TileProps {
  x: number;
  y: number;
  s: string;
  role: CardRole;
  k?: number;
  w?: number;
  alpha?: number;
  dash?: boolean;
}

/** An event tile: a hole-coloured slot with an outline in one role. */
export function Tile({
  x,
  y,
  s,
  role,
  k = 1,
  w = 36,
  alpha = 1,
  dash,
}: TileProps) {
  const { fade } = usePart();
  const a = fade * alpha;
  if (k <= 0 || a <= 0) return null;
  const h = 28;
  const textRole: Role = role === "edge" ? "dim" : role;
  return (
    <g className="md-tile" opacity={a < 1 ? a : undefined}>
      <g transform={`translate(${x} ${y}) scale(${k})`}>
        <rect
          x={-w / 2}
          y={-h / 2}
          width={w}
          height={h}
          rx={5}
          fill={roleColor("hole")}
          stroke={roleColor(role)}
          strokeWidth={2}
          strokeDasharray={dash ? "4 4" : undefined}
        />
      </g>
      {s && k > 0.6 && (
        <SvgText
          x={x}
          y={y + 1}
          runs={[[s, 600, textRole]]}
          size={18}
          align="center"
        />
      )}
    </g>
  );
}

/** Every tile of a list at `t` (gallery `tiles`). */
export function Tiles({ list, t }: { list: readonly TileSpec[]; t: number }) {
  return (
    <>
      {list.map((q, i) => {
        if (q.at >= 0 && t < q.at) return null;
        let alpha = 1;
        if (q.gone != null) alpha = 1 - smoothstep(q.gone, q.gone + 0.3, t);
        if (q.dimAt != null)
          alpha *= 1 - 0.6 * smoothstep(q.dimAt, q.dimAt + 0.3, t);
        return (
          <Tile
            key={i}
            x={q.x}
            y={q.y}
            s={q.s}
            role={valueAt(q.col, t)}
            k={q.at >= 0 ? pop(t - q.at) : 1}
            w={q.w}
            alpha={alpha}
            dash={q.dimAt != null && t >= q.dimAt}
          />
        );
      })}
    </>
  );
}

/** A triangle pointing at a tile (heads, playheads, committed offsets). */
export function Pointer({
  x,
  y,
  role,
  dir = 1,
  label,
}: {
  x: number;
  y: number;
  role: Role;
  dir?: 1 | -1;
  label?: string;
}) {
  const { fade } = usePart();
  return (
    <g className="md-pointer">
      <path
        d={`M${x} ${y} L${x - 7} ${y + 12 * dir} L${x + 7} ${y + 12 * dir} Z`}
        fill={roleColor(role)}
        opacity={fade < 1 ? fade : undefined}
      />
      {label && (
        <SvgText
          x={x}
          y={y + 26 * dir}
          runs={[[label, 400, "dim"]]}
          size={18}
          align="center"
          opacity={fade}
        />
      )}
    </g>
  );
}

/** A caption whose text swaps over time (gallery `note(list, t, x, y, size, align)`). */
export function ValueNote({
  list,
  t,
  x,
  y,
  size = 18,
  align = "center",
}: {
  list: readonly StatusNote[];
  t: number;
  x: number;
  y: number;
  size?: number;
  align?: "left" | "center" | "right";
}) {
  return (
    <StatusLine
      status={statusAt(list, t)}
      x={x}
      y={y}
      size={size}
      align={align}
    />
  );
}
