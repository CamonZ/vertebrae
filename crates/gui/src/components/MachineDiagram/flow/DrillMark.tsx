import type { BBox } from "../ChangeMark";
import { roleColor } from "../palette";

/** Badge radius and gaps, in diagram units (constant whatever the part's scale). */
const R = 15;
/** Clear of the change mark's frame (8 part units out) and its stroke. */
const GAP = 14;

/**
 * Badge just outside the top-right corner of a part's frame: two stacked
 * frames, the deeper diagram behind this part. It sits right of the frame and
 * below the name drawn above it, so long names do not run into it, and keeps
 * its size when the part is drawn small. A shape, not a colour; the part's
 * accessible name says what activation opens.
 */
export function DrillMark({ bb, scale = 1 }: { bb: BBox; scale?: number }) {
  const [x, y, w] = bb;
  const u = 1 / scale;
  const r = R * u;
  const cx = x + w + (GAP + R) * u;
  const cy = y + r;
  const s = (v: number) => v * u;
  return (
    <g
      className="md-drill"
      data-testid="flow-drill-mark"
      aria-hidden
      pointerEvents="none"
    >
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill={roleColor("bg")}
        stroke={roleColor("ink")}
        strokeWidth={s(2)}
      />
      <rect
        x={cx - s(3)}
        y={cy - s(7)}
        width={s(10)}
        height={s(10)}
        rx={s(1.5)}
        fill="none"
        stroke={roleColor("ink")}
        strokeWidth={s(1.5)}
      />
      <rect
        x={cx - s(7)}
        y={cy - s(3)}
        width={s(10)}
        height={s(10)}
        rx={s(1.5)}
        fill={roleColor("bg")}
        stroke={roleColor("ink")}
        strokeWidth={s(1.5)}
      />
    </g>
  );
}
