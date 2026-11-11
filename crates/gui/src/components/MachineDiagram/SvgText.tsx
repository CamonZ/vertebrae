import { MIN_TEXT_SIZE, roleColor, type Role } from "./palette";
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
}

/** Real, selectable SVG text in the app's monospace font. Hidden when labels are off. */
export function SvgText({
  x,
  y,
  runs,
  size = 20,
  align = "left",
  opacity = 1,
}: SvgTextProps) {
  const { labels } = usePart();
  if (!labels || opacity <= 0) return null;
  return (
    <text
      x={x}
      y={y}
      fontSize={Math.max(MIN_TEXT_SIZE, size)}
      dominantBaseline="middle"
      textAnchor={ANCHOR[align]}
      opacity={opacity < 1 ? opacity : undefined}
      xmlSpace="preserve"
    >
      {runs.map(([text, weight = 400, role = "ink"], i) => (
        <tspan key={i} fontWeight={weight} fill={roleColor(role)}>
          {text}
        </tspan>
      ))}
    </text>
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
  return (
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
