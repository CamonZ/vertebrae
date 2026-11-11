import type { ChangeMark as Mark } from "./accessibility";
import { roleColor } from "./palette";
import { SvgText } from "./SvgText";
import { usePart } from "./partContext";

export type BBox = readonly [x: number, y: number, w: number, h: number];

const TAB_TEXT: Record<Exclude<Mark, "unchanged">, string> = {
  added: "+ added",
  changed: "~ changed",
  removed: "− removed",
};

/** Monospace advance at 18 px (JetBrains Mono ≈ 0.6 em), for tab width. */
const CHAR_WIDTH_18 = 10.8;

export interface ChangeMarkProps {
  mark: Mark;
  bb: BBox;
  /** Tab position override, where the part's own text sits above the frame. */
  tab?: readonly [number, number];
}

/**
 * Per-part change mark (VL-08): + heavy ink outline and a solid tab; ~ ink
 * corner brackets and an outlined tab; − dashed frame and a dashed dim tab.
 * Ink and grey only, so state colour inside the part survives the mark.
 */
export function ChangeMark({ mark, bb, tab }: ChangeMarkProps) {
  const { labels } = usePart();
  if (mark === "unchanged") return null;
  const [x, y, w, h] = bb;
  const X = x - 8;
  const Y = y - 8;
  const W = w + 16;
  const H = h + 16;
  const a = 28;
  const text = TAB_TEXT[mark];
  const [tx, ty] = tab ?? [X + 22, Y];
  const tw = text.length * CHAR_WIDTH_18 + 20;
  return (
    <g className="md-change" data-mark={mark}>
      {mark === "added" && (
        <rect
          x={X}
          y={Y}
          width={W}
          height={H}
          rx={24}
          fill="none"
          stroke={roleColor("ink")}
          strokeWidth={3.5}
        />
      )}
      {mark === "changed" && (
        <path
          d={(
            [
              [X, Y, 1, 1],
              [X + W, Y, -1, 1],
              [X, Y + H, 1, -1],
              [X + W, Y + H, -1, -1],
            ] as const
          )
            .map(
              ([cx, cy, sx, sy]) =>
                `M${cx + sx * a} ${cy} L${cx} ${cy} L${cx} ${cy + sy * a}`
            )
            .join(" ")}
          fill="none"
          stroke={roleColor("ink")}
          strokeWidth={3.5}
          strokeLinecap="round"
        />
      )}
      {mark === "removed" && (
        <rect
          x={X}
          y={Y}
          width={W}
          height={H}
          rx={24}
          fill="none"
          stroke={roleColor("edge")}
          strokeWidth={2}
          strokeDasharray="6 6"
        />
      )}
      {labels && (
        <g className="md-change-tab">
          <rect
            x={tx}
            y={ty - 14}
            width={tw}
            height={28}
            rx={14}
            fill={roleColor(mark === "added" ? "ink" : "bg")}
            stroke={
              mark === "added"
                ? undefined
                : roleColor(mark === "changed" ? "ink" : "edge")
            }
            strokeWidth={mark === "added" ? undefined : 2}
            strokeDasharray={mark === "removed" ? "4 4" : undefined}
          />
          <SvgText
            x={tx + 10}
            y={ty + 1}
            runs={[
              [
                text,
                600,
                mark === "added" ? "bg" : mark === "changed" ? "ink" : "dim",
              ],
            ]}
            size={18}
          />
        </g>
      )}
    </g>
  );
}

/**
 * The removed/absent ghost: the part stands idle behind a veil, its frame
 * hatched. No cards travel (stateAt returns none for these poses).
 */
export function RemovedGhost({
  bb,
  width,
  height,
}: {
  bb: BBox;
  width: number;
  height: number;
}) {
  const { hatchId } = usePart();
  const [x, y, w, h] = bb;
  return (
    <g className="md-ghost">
      <rect
        x={0}
        y={48}
        width={width}
        height={height - 90}
        fill={roleColor("bg")}
        opacity={0.5}
      />
      <rect
        x={x - 8}
        y={y - 8}
        width={w + 16}
        height={h + 16}
        rx={24}
        fill={`url(#${hatchId})`}
        opacity={0.55}
      />
    </g>
  );
}

/** Hatch pattern definition; one per diagram, referenced by RemovedGhost. */
export function HatchPattern({ id }: { id: string }) {
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width={16} height={16}>
      <path
        d="M-4 4 L4 -4 M0 16 L16 0 M12 20 L20 12"
        stroke={roleColor("edge")}
        strokeWidth={1.5}
        fill="none"
      />
    </pattern>
  );
}
