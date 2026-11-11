import { roleColor } from "./palette";
import type { GateFrame } from "./timeline";

/**
 * A pill gate where a rail meets a frame (VL-05). The two pills part while a
 * card crosses (`open`) and close behind it; amber while the part holds work.
 */
export function Gate({ frame: g }: { frame: GateFrame }) {
  const fill = roleColor(g.amber ? "amber" : "fill");
  const stroke = roleColor(g.amber ? "amber" : "dim");
  return (
    <g className="md-gate" data-open={g.open > 0 ? "true" : "false"}>
      {[-1, 1].map((s) =>
        g.orientation === "v" ? (
          <rect
            key={s}
            x={g.x - 4.5}
            y={g.y + s * g.offset - 10}
            width={9}
            height={20}
            rx={4.5}
            fill={fill}
            stroke={stroke}
            strokeWidth={1.5}
          />
        ) : (
          <rect
            key={s}
            x={g.x + s * g.offset - 10}
            y={g.y - 4.5}
            width={20}
            height={9}
            rx={4.5}
            fill={fill}
            stroke={stroke}
            strokeWidth={1.5}
          />
        )
      )}
    </g>
  );
}
