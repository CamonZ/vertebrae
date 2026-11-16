import type { ReactElement } from "react";
import { MIN_TEXT_SIZE, roleColor, type Role } from "./palette";
import {
  invert,
  partTurn,
  svgMatrix,
  turnAlign,
  type FlowDirection,
} from "./orientation";
import { usePart } from "./partContext";

export type TextAlign = "left" | "center" | "right";
const ANCHOR = { left: "start", center: "middle", right: "end" } as const;

/** One run of a text line: `[text, weight, role]`. */
export type TextRun = readonly [text: string, weight?: 400 | 600, role?: Role];

export interface SvgTextProps {
  x: number;
  y: number;
  runs: readonly TextRun[];
  /** Font size in logical px; never below 18 (VL-04). */
  size?: number;
  align?: TextAlign;
  opacity?: number;
  /** Extra px between characters (headings). */
  letterSpacing?: number;
}

/**
 * Text colour for a role. Neutral text uses its own steps: muted text a
 * brighter grey, ink a touch under full ink. State colours stay as they are.
 */
function textColor(role: Role): string {
  if (role === "dim") return "var(--md-text-dim)";
  if (role === "ink") return "var(--md-text-ink)";
  return roleColor(role);
}

/** Real, selectable SVG text in the app's monospace font. Hidden when labels are off. */
export function SvgText({
  x,
  y,
  runs,
  size = 20,
  align = "left",
  opacity = 1,
  letterSpacing,
}: SvgTextProps) {
  const { labels, turn } = usePart();
  if (!labels || opacity <= 0) return null;
  return upright(
    turn,
    x,
    y,
    <text
      x={x}
      y={y}
      fontSize={Math.max(MIN_TEXT_SIZE, size)}
      dominantBaseline="middle"
      textAnchor={ANCHOR[(turn && turnAlign(turn, align)) ?? align]}
      opacity={opacity < 1 ? opacity : undefined}
      letterSpacing={letterSpacing}
      xmlSpace="preserve"
    >
      {runs.map(([text, weight = 400, role = "ink"], i) => (
        <tspan key={i} fontWeight={weight} fill={textColor(role)}>
          {text}
        </tspan>
      ))}
    </text>
  );
}

/**
 * Inside a turned drawing, undo the turn's linear part around the text's
 * anchor: the anchor moves with the mechanism, the text stays upright.
 */
function upright(
  turn: FlowDirection | undefined,
  x: number,
  y: number,
  text: ReactElement
): ReactElement {
  if (!turn || turn === "right") return text;
  const back = { ...invert(partTurn(turn)), e: 0, f: 0 };
  return (
    <g
      transform={`translate(${x} ${y}) ${svgMatrix(back)} translate(${-x} ${-y})`}
    >
      {text}
    </g>
  );
}

/** A centred single glyph (+, ×, >) drawn with weight 600. */
export function Glyph({
  x,
  y,
  text,
  size,
  role,
  opacity = 1,
}: {
  x: number;
  y: number;
  text: string;
  size: number;
  role: Role;
  opacity?: number;
}) {
  const { turn } = usePart();
  return upright(
    turn,
    x,
    y,
    <text
      x={x}
      y={y}
      fontSize={Math.max(MIN_TEXT_SIZE, size)}
      fontWeight={600}
      dominantBaseline="middle"
      textAnchor="middle"
      fill={roleColor(role)}
      opacity={opacity < 1 ? opacity : undefined}
    >
      {text}
    </text>
  );
}
