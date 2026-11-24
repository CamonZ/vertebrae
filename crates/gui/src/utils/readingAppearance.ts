/**
 * Text size: the one user setting that scales the whole type scale. It sets
 * --text-scale on <html>, which multiplies the root font size, so every rem
 * token (type, and rem-based spacing with it) grows or shrinks together.
 */
export const TEXT_SIZE_PRESETS = [
  { value: "smaller", label: "Smaller", percent: 85 },
  { value: "small", label: "Small", percent: 92 },
  { value: "default", label: "Default", percent: 100 },
  { value: "medium", label: "Medium", percent: 108 },
  { value: "large", label: "Large", percent: 115 },
  { value: "larger", label: "Larger", percent: 122 },
  { value: "extra-large", label: "Extra large", percent: 130 },
] as const;

export const MIN_TEXT_SIZE_PERCENT = 75;
export const MAX_TEXT_SIZE_PERCENT = 150;

export type TextSize = (typeof TEXT_SIZE_PRESETS)[number]["value"] | number;

export function isTextSizePercent(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= MIN_TEXT_SIZE_PERCENT && value <= MAX_TEXT_SIZE_PERCENT;
}

export function resolveTextSize(value: unknown): TextSize {
  if (isTextSizePercent(value)) return value;
  return TEXT_SIZE_PRESETS.find((preset) => preset.value === value)?.value ?? "default";
}

export function textSizePercent(size: TextSize): number {
  if (typeof size === "number") return size;
  return TEXT_SIZE_PRESETS.find((preset) => preset.value === size)?.percent ?? 100;
}

/** Old reading-size presets, kept only to migrate saved preferences. */
const LEGACY_READING_PERCENT = new Map<unknown, number>([
  ["smaller", 85],
  ["small", 95],
  ["default", 100],
  ["medium", 108],
  ["large", 115],
  ["larger", 122],
  ["extra-large", 130],
]);

/**
 * Text size for preferences saved before Text size replaced Density and
 * Reading text size. A non-default reading size wins because the user chose
 * it; otherwise a pinned density maps to the size its small text rendered at
 * (comfortable lifted 12px to 13px, compact dropped it to 11px).
 */
export function migrateLegacyTextSize(
  readingTextSize: unknown,
  density: unknown
): TextSize {
  const reading = isTextSizePercent(readingTextSize)
    ? readingTextSize
    : LEGACY_READING_PERCENT.get(readingTextSize);
  if (reading !== undefined && reading !== 100) {
    return TEXT_SIZE_PRESETS.find((preset) => preset.percent === reading)?.value ?? reading;
  }
  if (density === "comfortable") return "medium";
  if (density === "compact") return "small";
  return "default";
}

export const TYPEFACE_ROLES = [
  { id: "sans", label: "Interface" },
  { id: "prose", label: "Reading text" },
  { id: "serif", label: "Display titles" },
  { id: "mono", label: "Code and data" },
] as const;

type TypefaceRole = (typeof TYPEFACE_ROLES)[number]["id"];
export type CustomTypefaces = Partial<Record<TypefaceRole, string>>;

export function resolveCustomTypefaces(value: unknown): CustomTypefaces {
  if (!value || typeof value !== "object") return {};
  const fonts: CustomTypefaces = {};
  for (const { id } of TYPEFACE_ROLES) {
    const entry = (value as Record<string, unknown>)[id];
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name && name.length <= 100 && !Array.from(name).some((char) => char < " " || char === "\u007f")) {
      fonts[id] = name;
    }
  }
  return fonts;
}
