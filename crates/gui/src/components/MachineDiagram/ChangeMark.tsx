import { useId } from "react";
import type { ChangeMark as Mark } from "./accessibility";
import { roleColor } from "./palette";
import { SvgText } from "./SvgText";
import { usePart } from "./partContext";
import type { PortSide } from "./route";
import { GHOST_PAD, GHOST_RADIUS, hatchPath, type BBox } from "./hatch";

export type { BBox };

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
  /**
   * Before/After morph progress (0 → 1) while the mark arrives: the + outline
   * draws on and the ~ brackets flare out and settle. Settled when absent.
   */
  morph?: number;
}

/**
 * Per-part change mark (VL-08): + heavy ink outline and a solid tab; ~ ink
 * corner brackets and an outlined tab; − dashed frame and a dashed dim tab.
 * Ink and grey only, so state colour inside the part survives the mark.
 */
export function ChangeMark({ mark, bb, tab, morph }: ChangeMarkProps) {
  const { labels } = usePart();
  if (mark === "unchanged") return null;
  const [x, y, w, h] = bb;
  // ~ brackets flare out by up to 10 px mid-morph and settle back on the frame.
  const flare =
    mark === "changed" && morph !== undefined
      ? 10 * Math.sin(Math.PI * morph)
      : 0;
  const X = x - 8 - flare;
  const Y = y - 8 - flare;
  const W = w + 16 + 2 * flare;
  const H = h + 16 + 2 * flare;
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
          {...(morph !== undefined
            ? {
                pathLength: 1,
                strokeDasharray: "1 1",
                strokeDashoffset: 1 - morph,
              }
            : {})}
        />
      )}
      {mark === "changed" && (
        <path
          d={bracketPath(X, Y, W, H, a)}
          fill="none"
          stroke={roleColor("ink")}
          strokeWidth={3.5 + flare / 4}
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

const GLYPH: Record<Exclude<Mark, "unchanged">, string> = {
  added: "+",
  changed: "~",
  removed: "−",
};

/**
 * A small tag naming a mark by its glyph: solid ink for +, outlined ink for
 * ~, dashed grey for −, so it reads without colour.
 */
function GlyphTag({
  mark,
  x,
  y,
  text,
  align = "center",
}: {
  mark: Exclude<Mark, "unchanged">;
  x: number;
  y: number;
  /** Text after the glyph, e.g. a port name. */
  text?: string;
  align?: "left" | "center";
}) {
  const label = text ? `${GLYPH[mark]} ${text}` : GLYPH[mark];
  const tw = label.length * CHAR_WIDTH_18 + 16;
  const x0 = align === "center" ? x - tw / 2 : x;
  return (
    <g className="md-change-glyph" data-mark={mark}>
      <rect
        x={x0}
        y={y - 13}
        width={tw}
        height={26}
        rx={13}
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
        x={x0 + 8}
        y={y + 1}
        runs={[
          [
            label,
            600,
            mark === "added" ? "bg" : mark === "changed" ? "ink" : "dim",
          ],
        ]}
        size={18}
      />
    </g>
  );
}

/** Corner brackets around a box, `a` px along each edge. */
function bracketPath(X: number, Y: number, W: number, H: number, a: number) {
  return (
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
    .join(" ");
}

/**
 * A change mark on one port, in part space: + a heavy ink ring, ~ ink corner
 * brackets, − a dashed grey ring; with labels on, a glyph tag names the port
 * (beside it for W/E ports, above-right for N/S ones).
 */
export function PortMark({
  mark,
  name,
  x,
  y,
  side,
}: {
  mark: Mark;
  name: string;
  x: number;
  y: number;
  side: PortSide;
}) {
  const { labels } = usePart();
  if (mark === "unchanged") return null;
  const r = 14;
  const [tx, ty, align] =
    side === "W" || side === "E"
      ? ([x, y - 34, "center"] as const)
      : ([x + 22, y, "left"] as const);
  return (
    <g className="md-port-mark" data-port={name} data-mark={mark}>
      {mark === "changed" ? (
        <path
          d={bracketPath(x - r, y - r, 2 * r, 2 * r, 9)}
          fill="none"
          stroke={roleColor("ink")}
          strokeWidth={3}
          strokeLinecap="round"
        />
      ) : (
        <circle
          cx={x}
          cy={y}
          r={r}
          fill="none"
          stroke={roleColor(mark === "added" ? "ink" : "edge")}
          strokeWidth={mark === "added" ? 3.5 : 2}
          strokeDasharray={mark === "removed" ? "4 4" : undefined}
        />
      )}
      {labels && (
        <GlyphTag mark={mark} x={tx} y={ty} text={name} align={align} />
      )}
    </g>
  );
}

/**
 * A change mark on a stage or station inside a part (pipeline stages, saga
 * steps, TaskRun stations): + a heavy ink outline, ~ ink corner brackets,
 * − a dashed grey outline over hatching; with labels on, a glyph tag at
 * `tag`. Ink and grey only, so the stage's lamp keeps its state colour.
 */
export function StageMark({
  mark,
  name,
  bb: [x, y, w, h],
  tag,
}: {
  mark: Mark;
  name: string;
  bb: BBox;
  tag: readonly [number, number];
}) {
  const { labels } = usePart();
  const clipId = `md-stage-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  if (mark === "unchanged") return null;
  return (
    <g className="md-stage-mark" data-stage={name} data-mark={mark}>
      {mark === "removed" && (
        <>
          <clipPath id={clipId}>
            <rect x={x} y={y} width={w} height={h} rx={12} />
          </clipPath>
          <path
            d={hatchPath([
              x + GHOST_PAD,
              y + GHOST_PAD,
              w - 2 * GHOST_PAD,
              h - 2 * GHOST_PAD,
            ])}
            clipPath={`url(#${clipId})`}
            stroke={roleColor("edge")}
            strokeWidth={1.5}
            opacity={0.55}
            fill="none"
          />
        </>
      )}
      {mark === "changed" ? (
        <path
          d={bracketPath(x, y, w, h, 16)}
          fill="none"
          stroke={roleColor("ink")}
          strokeWidth={3}
          strokeLinecap="round"
        />
      ) : (
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={12}
          fill="none"
          stroke={roleColor(mark === "added" ? "ink" : "edge")}
          strokeWidth={mark === "added" ? 3.5 : 2}
          strokeDasharray={mark === "removed" ? "6 6" : undefined}
        />
      )}
      {labels && <GlyphTag mark={mark} x={tag[0]} y={tag[1]} />}
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
  const clipId = `${hatchId}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
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
      <clipPath id={clipId}>
        <rect
          x={x - GHOST_PAD}
          y={y - GHOST_PAD}
          width={w + 2 * GHOST_PAD}
          height={h + 2 * GHOST_PAD}
          rx={GHOST_RADIUS}
        />
      </clipPath>
      <path
        className="md-hatch"
        d={hatchPath(bb)}
        clipPath={`url(#${clipId})`}
        stroke={roleColor("edge")}
        strokeWidth={1.5}
        opacity={0.55}
        fill="none"
      />
    </g>
  );
}
