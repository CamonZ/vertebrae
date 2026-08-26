export const THINKING_MATRIX_COLUMNS = 8;
export const THINKING_MATRIX_ROWS = 5;
export const THINKING_MATRIX_LIGHT_COUNT =
  THINKING_MATRIX_COLUMNS * THINKING_MATRIX_ROWS;
export const THINKING_MAX_RADIAL_BAND = Math.floor(
  Math.hypot((THINKING_MATRIX_COLUMNS - 1) / 2, (THINKING_MATRIX_ROWS - 1) / 2)
);

/** A horizontally wide almond spanning the 8x5 light field. */
export const THINKING_ALMOND_MASK = [
  "...XX...",
  ".XXXXXX.",
  "XXXXXXXX",
  ".XXXXXX.",
  "...XX...",
] as const;

/** Return the concentric radial band for a cell in the 8x5 field. */
export function getThinkingRadialBand(row: number, column: number): number {
  const centerColumn = (THINKING_MATRIX_COLUMNS - 1) / 2;
  const centerRow = (THINKING_MATRIX_ROWS - 1) / 2;
  return Math.floor(Math.hypot(column - centerColumn, row - centerRow));
}
