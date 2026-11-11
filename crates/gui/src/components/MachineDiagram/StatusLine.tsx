import { SvgText, type TextAlign } from "./SvgText";
import type { StatusFrame } from "./timeline";

export interface StatusLineProps {
  status: StatusFrame;
  x: number;
  y: number;
  size?: number;
  align?: TextAlign;
}

/**
 * The one status line under a part (VL-04). During a swap the outgoing text
 * rises and fades while the new text rises in; both offsets come from
 * `statusAt`, so the component holds no animation state.
 */
export function StatusLine({
  status,
  x,
  y,
  size = 20,
  align = "center",
}: StatusLineProps) {
  const { previous, current } = status;
  return (
    <g className="md-status">
      {previous && (
        <SvgText
          x={x}
          y={y + previous.dy}
          runs={[[previous.text, 400, previous.role]]}
          size={size}
          align={align}
          opacity={previous.alpha}
        />
      )}
      <SvgText
        x={x}
        y={y + current.dy}
        runs={[[current.text, 400, current.role]]}
        size={size}
        align={align}
        opacity={current.alpha}
      />
    </g>
  );
}
