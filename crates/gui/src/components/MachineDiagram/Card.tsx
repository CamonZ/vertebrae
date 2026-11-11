import type { KeyboardEvent, MouseEvent } from "react";
import { isActivationKey, useDiagramInteraction } from "./interaction";
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
  const interaction = useDiagramInteraction();
  const activate = interaction?.onActivateCard;
  const interactive = c.id !== undefined && activate !== undefined;
  const followed = c.id !== undefined && interaction?.followedCard === c.id;
  const dimmed =
    !followed && interaction?.followedCard != null ? DIMMED : undefined;
  const handlers =
    interactive && c.id !== undefined
      ? cardHandlers(c.id, activate!)
      : undefined;
  return (
    <g
      className="md-card"
      data-card={c.index}
      data-card-id={c.id}
      data-followed={followed ? "true" : undefined}
      opacity={dimmed}
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": `Card ${c.id}${followed ? ", following" : ""}`,
            "aria-pressed": followed,
          }
        : {})}
      {...handlers}
    >
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
        {followed && (
          <Shape
            dot={c.dot}
            w={c.w + FOLLOW_PAD * 2}
            h={c.h + FOLLOW_PAD * 2}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={3}
          />
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

/** Opacity of the other cards while one is followed. */
const DIMMED = 0.35;
/** Gap between a followed card and its highlight ring. */
const FOLLOW_PAD = 5;

function cardHandlers(id: string, activate: (id: string) => void) {
  return {
    onClick: (e: MouseEvent<SVGGElement>) => {
      // Cards ride inside parts: following one must not also activate the part.
      e.stopPropagation();
      activate(id);
    },
    onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
      if (!isActivationKey(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      activate(id);
    },
  };
}
