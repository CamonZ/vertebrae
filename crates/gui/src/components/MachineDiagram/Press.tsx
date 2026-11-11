import { roleColor } from "./palette";
import { usePart } from "./partContext";

export interface PressProps {
  cx: number;
  cy: number;
  /** Distance from the centre to each mount. */
  half: number;
  /** Plate closure 0..1 (clamp spring, see `held`). */
  closed: number;
  /** Lights lit on each mount, 0..6. */
  lit: number;
  /** When the plates clamp; sparks fly for 0.4 s after it. */
  clampAt?: number | null;
  t: number;
  /** Plates move vertically (default) or horizontally. */
  vertical?: boolean;
}

/**
 * The press from the reference language: two mounts with six lights, plates
 * on stems that clamp the card, an amber glow while closed and sparks on impact.
 */
export function Press({
  cx,
  cy,
  half,
  closed,
  lit,
  clampAt = null,
  t,
  vertical = true,
}: PressProps) {
  const { fade } = usePart();
  const rest = half - 12;
  const py = rest - (rest - 21) * closed;
  const plate = roleColor("plate");
  const d = clampAt == null ? -1 : t - clampAt - 0.08;
  const sparkK = d > 0 && d < 0.4 ? d / 0.4 : null;
  return (
    <g
      className="md-press"
      transform={vertical ? undefined : `rotate(90 ${cx} ${cy})`}
    >
      {closed > 0 && (
        <rect
          x={cx - 27}
          y={cy - 20}
          width={54}
          height={40}
          fill={roleColor("amber")}
          opacity={0.22 * closed * fade}
        />
      )}
      {[-1, 1].map((s) => (
        <g key={s}>
          <rect
            x={cx - 42}
            y={cy + s * half - 5}
            width={84}
            height={10}
            rx={3}
            fill={roleColor("edge")}
          />
          {Array.from({ length: 6 }, (_, i) => (
            <rect
              key={i}
              x={cx - 33 + i * 12}
              y={cy + s * half - 1.5}
              width={8}
              height={3}
              fill={roleColor(i < lit ? "amber" : "hole")}
            />
          ))}
        </g>
      ))}
      <path
        d={`M${cx} ${cy - half + 5} L${cx} ${cy - py} M${cx} ${cy + half - 5} L${cx} ${cy + py}`}
        stroke={plate}
        strokeWidth={5}
        strokeLinecap="butt"
      />
      <rect x={cx - 36} y={cy - py - 4.5} width={72} height={9} fill={plate} />
      <rect x={cx - 36} y={cy + py - 4.5} width={72} height={9} fill={plate} />
      {sparkK != null && (
        <g
          stroke={roleColor("dim")}
          strokeWidth={2}
          strokeLinecap="round"
          opacity={(1 - sparkK) * fade}
        >
          {[-1, 1].flatMap((sg) =>
            [-1, 0, 1].map((j) => {
              const x = cx + sg * (34 + 22 * sparkK);
              return (
                <line
                  key={`${sg}${j}`}
                  x1={x}
                  y1={cy + j * 9}
                  x2={x + sg * 12}
                  y2={cy + j * 9}
                />
              );
            })
          )}
        </g>
      )}
    </g>
  );
}
