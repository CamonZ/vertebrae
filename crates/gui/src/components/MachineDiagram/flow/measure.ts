/**
 * Text and box measurement shared by the extent and band geometry:
 * monospace text is estimated at 0.6 em per character and 1.2 em per line.
 */
import type { TextAlign } from "../SvgText";

export interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Monospace advance per px of font size (JetBrains Mono / IBM Plex Mono ≈ 0.6 em). */
export const CHAR_EM = 0.6;
/** Line box per px of font size. */
export const LINE_EM = 1.2;

export const textWidth = (text: string, size: number) =>
  text.length * size * CHAR_EM;

/** A single line centred on `y` (SvgText uses dominant-baseline middle). */
export function textBox(
  x: number,
  y: number,
  text: string,
  size: number,
  align: TextAlign = "left"
): Box {
  const w = textWidth(text, size);
  const h = size * LINE_EM;
  const x0 = align === "left" ? x : align === "center" ? x - w / 2 : x - w;
  return { x0, y0: y - h / 2, x1: x0 + w, y1: y + h / 2 };
}
