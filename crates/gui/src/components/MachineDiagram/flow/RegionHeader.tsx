import { isActivationKey } from "../interaction";
import { SvgText } from "../SvgText";
import type { DiagramRegion } from "./compile";
import { regionLabelAt, regionCountAt } from "./extent";
import { textWidth } from "./measure";
import { countDescription, type FlowPresentation } from "./presentation";

export function LiveCount({
  count,
  x,
  y,
}: {
  count?: { total: number; running: number };
  x: number;
  y: number;
}) {
  if (!count || (count.total <= 0 && count.running <= 0)) return null;
  return (
    <g className="md-live-count" aria-hidden="true">
      <SvgText
        x={x}
        y={y}
        size={18}
        runs={[
          [`${count.total} parked`, 600, "ink"],
          ...(count.running > 0
            ? [[` · ${count.running} active`, 600, "green"] as const]
            : []),
        ]}
      />
    </g>
  );
}

/** Header hit target stays inside the compiled region's reserved header. */
export function RegionHeader({
  region: g,
  presentation: p,
}: {
  region: DiagramRegion;
  presentation: FlowPresentation;
}) {
  const interactive = !!p.onActivateRegion;
  const count = p.counts?.get(g.id);
  const [labelX, labelY] = regionLabelAt(g);
  const [countX, countY] = regionCountAt(g);
  const countWidth = count
    ? textWidth(`${count.total} parked · ${count.running} active`, 18)
    : 0;
  return (
    <g
      className="md-region-header"
      data-region-header={g.id}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={[g.label ?? g.id, countDescription(count)]
        .filter(Boolean)
        .join(". ")}
      aria-pressed={interactive ? !!p.selected?.has(g.id) : undefined}
      data-selected={p.selected?.has(g.id) || undefined}
      onClick={() => p.onActivateRegion?.(g.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || !isActivationKey(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        p.onActivateRegion?.(g.id);
      }}
      onMouseEnter={() => p.onHoverRegion?.(g.id)}
      onMouseLeave={() => p.onHoverRegion?.(null)}
      onFocus={() => p.onFocusRegion?.(g.id)}
      onBlur={() => p.onFocusRegion?.(null)}
    >
      <rect
        className="md-header-hit"
        x={g.x + 6}
        y={g.y + 2}
        width={Math.min(
          g.width - 12,
          Math.max(textWidth(g.label ?? "", 18), countWidth) + 28
        )}
        height={46}
        rx={8}
      />
      <SvgText
        x={labelX}
        y={labelY}
        size={18}
        runs={[[g.label ?? "", 600, "ink"]]}
      />
      {g.liveHeader && <LiveCount count={count} x={countX} y={countY} />}
    </g>
  );
}
