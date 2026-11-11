import { roleColor } from "./palette";
import { SvgText } from "./SvgText";
import type { CardFrame } from "./timeline";

function Shape({
  dot,
  w,
  h,
  x = 0,
  y = 0,
  ...rest
}: {
  dot: boolean;
  w: number;
  h: number;
  x?: number;
  y?: number;
  fill: string;
  opacity?: number;
  stroke?: string;
  strokeWidth?: number;
}) {
  return dot ? (
    <circle cx={x} cy={y} r={w / 2} {...rest} />
  ) : (
    <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={4} {...rest} />
  );
}

/**
 * A card (work token) as resolved by `stateAt`: smear ghosts behind it, the
 * body leaning as it leaves a slot, an optional green badge, and its tags.
 * Hollow cards are control signals: outline only, never smeared.
 */
export function Card({ frame: c }: { frame: CardFrame }) {
  const fill = roleColor(c.role);
  return (
    <g className="md-card" data-card={c.index} data-card-id={c.id}>
      {c.ghosts.map((g, i) => (
        <Shape
          key={i}
          dot={c.dot}
          w={c.w}
          h={c.h}
          x={g.x}
          y={g.y}
          fill={fill}
          opacity={g.alpha}
        />
      ))}
      <g
        transform={`translate(${c.x} ${c.y}) rotate(${c.angle})`}
        opacity={c.alpha}
      >
        {c.hollow ? (
          <Shape
            dot={c.dot}
            w={c.w}
            h={c.h}
            fill={roleColor("bg")}
            stroke={fill}
            strokeWidth={2}
          />
        ) : (
          <Shape dot={c.dot} w={c.w} h={c.h} fill={fill} />
        )}
        {c.badge && (
          <circle
            cx={c.w / 2 - 1}
            cy={-c.h / 2 + 1}
            r={4}
            fill={roleColor("green")}
            stroke={roleColor("hole")}
            strokeWidth={1.5}
          />
        )}
      </g>
      {c.tags.map((tag, i) => (
        <SvgText
          key={i}
          x={tag.x}
          y={tag.y}
          runs={[[tag.text, 600, tag.role]]}
          size={18}
          align="center"
          opacity={tag.alpha}
        />
      ))}
    </g>
  );
}
