export const READING_SIZE_PRESETS = [
  { value: "smaller", label: "Smaller", percent: 85 },
  { value: "small", label: "Small", percent: 95 },
  { value: "default", label: "Default", percent: 100 },
  { value: "medium", label: "Medium", percent: 108 },
  { value: "large", label: "Large", percent: 115 },
  { value: "larger", label: "Larger", percent: 122 },
  { value: "extra-large", label: "Extra large", percent: 130 },
] as const;

export const MIN_READING_PERCENT = 75;
export const MAX_READING_PERCENT = 150;

export type ReadingTextSize = (typeof READING_SIZE_PRESETS)[number]["value"] | number;

export function isReadingPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= MIN_READING_PERCENT && value <= MAX_READING_PERCENT;
}

export function resolveReadingTextSize(value: unknown): ReadingTextSize {
  if (isReadingPercent(value)) return value;
  return READING_SIZE_PRESETS.find((preset) => preset.value === value)?.value ?? "default";
}

export function readingPercent(size: ReadingTextSize): number {
  if (typeof size === "number") return size;
  return READING_SIZE_PRESETS.find((preset) => preset.value === size)?.percent ?? 100;
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
