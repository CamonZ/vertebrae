/**
 * Code appearance preferences shared by fenced chat code blocks, Pierre diffs
 * and inline code. Kept free of Pierre imports so the main chunk can read it.
 */

export type ColorScheme = "dark" | "light";

/** A bundled syntax theme and the appearance it was designed for. */
export interface CodeTheme {
  name: string;
  label: string;
  scheme: ColorScheme;
}

/**
 * Every theme bundled with Highlights. Each name also exists in the Shiki
 * (TextMate) catalog, so the Shiki fallback renders the same selection.
 */
export const CODE_THEMES: readonly CodeTheme[] = [
  { name: "andromeeda", label: "Andromeeda", scheme: "dark" },
  { name: "aurora-x", label: "Aurora X", scheme: "dark" },
  { name: "ayu-dark", label: "Ayu Dark", scheme: "dark" },
  { name: "ayu-mirage", label: "Ayu Mirage", scheme: "dark" },
  { name: "ayu-light", label: "Ayu Light", scheme: "light" },
  { name: "catppuccin-frappe", label: "Catppuccin Frappé", scheme: "dark" },
  {
    name: "catppuccin-macchiato",
    label: "Catppuccin Macchiato",
    scheme: "dark",
  },
  { name: "catppuccin-mocha", label: "Catppuccin Mocha", scheme: "dark" },
  { name: "catppuccin-latte", label: "Catppuccin Latte", scheme: "light" },
  { name: "dark-plus", label: "Dark+ (VS Code)", scheme: "dark" },
  { name: "light-plus", label: "Light+ (VS Code)", scheme: "light" },
  { name: "dracula", label: "Dracula", scheme: "dark" },
  { name: "dracula-soft", label: "Dracula Soft", scheme: "dark" },
  { name: "everforest-dark", label: "Everforest Dark", scheme: "dark" },
  { name: "everforest-light", label: "Everforest Light", scheme: "light" },
  { name: "github-dark", label: "GitHub Dark", scheme: "dark" },
  { name: "github-dark-default", label: "GitHub Dark Default", scheme: "dark" },
  { name: "github-dark-dimmed", label: "GitHub Dark Dimmed", scheme: "dark" },
  {
    name: "github-dark-high-contrast",
    label: "GitHub Dark High Contrast",
    scheme: "dark",
  },
  { name: "github-light", label: "GitHub Light", scheme: "light" },
  {
    name: "github-light-default",
    label: "GitHub Light Default",
    scheme: "light",
  },
  {
    name: "github-light-high-contrast",
    label: "GitHub Light High Contrast",
    scheme: "light",
  },
  { name: "gruvbox-dark-hard", label: "Gruvbox Dark Hard", scheme: "dark" },
  { name: "gruvbox-dark-medium", label: "Gruvbox Dark Medium", scheme: "dark" },
  { name: "gruvbox-dark-soft", label: "Gruvbox Dark Soft", scheme: "dark" },
  { name: "gruvbox-light-hard", label: "Gruvbox Light Hard", scheme: "light" },
  {
    name: "gruvbox-light-medium",
    label: "Gruvbox Light Medium",
    scheme: "light",
  },
  { name: "gruvbox-light-soft", label: "Gruvbox Light Soft", scheme: "light" },
  { name: "horizon", label: "Horizon", scheme: "dark" },
  { name: "horizon-bright", label: "Horizon Bright", scheme: "light" },
  { name: "houston", label: "Houston", scheme: "dark" },
  { name: "kanagawa-dragon", label: "Kanagawa Dragon", scheme: "dark" },
  { name: "kanagawa-wave", label: "Kanagawa Wave", scheme: "dark" },
  { name: "kanagawa-lotus", label: "Kanagawa Lotus", scheme: "light" },
  { name: "laserwave", label: "LaserWave", scheme: "dark" },
  { name: "material-theme", label: "Material Theme", scheme: "dark" },
  {
    name: "material-theme-darker",
    label: "Material Theme Darker",
    scheme: "dark",
  },
  {
    name: "material-theme-ocean",
    label: "Material Theme Ocean",
    scheme: "dark",
  },
  {
    name: "material-theme-palenight",
    label: "Material Theme Palenight",
    scheme: "dark",
  },
  {
    name: "material-theme-lighter",
    label: "Material Theme Lighter",
    scheme: "light",
  },
  { name: "min-dark", label: "Min Dark", scheme: "dark" },
  { name: "min-light", label: "Min Light", scheme: "light" },
  { name: "monokai", label: "Monokai", scheme: "dark" },
  { name: "night-owl", label: "Night Owl", scheme: "dark" },
  { name: "night-owl-light", label: "Night Owl Light", scheme: "light" },
  { name: "nord", label: "Nord", scheme: "dark" },
  { name: "one-dark-pro", label: "One Dark Pro", scheme: "dark" },
  { name: "one-light", label: "One Light", scheme: "light" },
  { name: "pierre-dark", label: "Pierre Dark", scheme: "dark" },
  { name: "pierre-dark-soft", label: "Pierre Dark Soft", scheme: "dark" },
  { name: "pierre-dark-vibrant", label: "Pierre Dark Vibrant", scheme: "dark" },
  {
    name: "pierre-dark-protanopia-deuteranopia",
    label: "Pierre Dark Protanopia & Deuteranopia",
    scheme: "dark",
  },
  {
    name: "pierre-dark-tritanopia",
    label: "Pierre Dark Tritanopia",
    scheme: "dark",
  },
  { name: "pierre-light", label: "Pierre Light", scheme: "light" },
  { name: "pierre-light-soft", label: "Pierre Light Soft", scheme: "light" },
  {
    name: "pierre-light-vibrant",
    label: "Pierre Light Vibrant",
    scheme: "light",
  },
  {
    name: "pierre-light-protanopia-deuteranopia",
    label: "Pierre Light Protanopia & Deuteranopia",
    scheme: "light",
  },
  {
    name: "pierre-light-tritanopia",
    label: "Pierre Light Tritanopia",
    scheme: "light",
  },
  { name: "plastic", label: "Plastic", scheme: "dark" },
  { name: "poimandres", label: "Poimandres", scheme: "dark" },
  { name: "red", label: "Red", scheme: "dark" },
  { name: "rose-pine", label: "Rosé Pine", scheme: "dark" },
  { name: "rose-pine-moon", label: "Rosé Pine Moon", scheme: "dark" },
  { name: "rose-pine-dawn", label: "Rosé Pine Dawn", scheme: "light" },
  { name: "slack-dark", label: "Slack Dark", scheme: "dark" },
  { name: "slack-ochin", label: "Slack Ochin", scheme: "light" },
  { name: "snazzy-light", label: "Snazzy Light", scheme: "light" },
  { name: "solarized-dark", label: "Solarized Dark", scheme: "dark" },
  { name: "solarized-light", label: "Solarized Light", scheme: "light" },
  { name: "synthwave-84", label: "Synthwave '84", scheme: "dark" },
  { name: "tokyo-night", label: "Tokyo Night", scheme: "dark" },
  { name: "vesper", label: "Vesper", scheme: "dark" },
  { name: "vitesse-black", label: "Vitesse Black", scheme: "dark" },
  { name: "vitesse-dark", label: "Vitesse Dark", scheme: "dark" },
  { name: "vitesse-light", label: "Vitesse Light", scheme: "light" },
];

export const DEFAULT_CODE_THEMES: Record<ColorScheme, string> = {
  dark: "pierre-dark",
  light: "pierre-light",
};

/** Bundled themes designed for one appearance. */
export function codeThemesFor(scheme: ColorScheme): readonly CodeTheme[] {
  return CODE_THEMES.filter((theme) => theme.scheme === scheme);
}

/**
 * Resolve the stored theme for one appearance, falling back to that
 * appearance's default when the name is no longer bundled or was designed
 * for the other appearance.
 */
export function resolveCodeTheme(
  name: string | null | undefined,
  scheme: ColorScheme
): string {
  return CODE_THEMES.some(
    (theme) => theme.name === name && theme.scheme === scheme
  )
    ? (name as string)
    : DEFAULT_CODE_THEMES[scheme];
}

const themePairs = new Map<string, { dark: string; light: string }>();

/** Pierre `theme` option; stable per combination so options stay equal. */
export function codeThemePair(
  dark: string | null | undefined,
  light: string | null | undefined
): { dark: string; light: string } {
  const pair = {
    dark: resolveCodeTheme(dark, "dark"),
    light: resolveCodeTheme(light, "light"),
  };
  const key = `${pair.dark}\u0000${pair.light}`;
  let cached = themePairs.get(key);
  if (!cached) {
    cached = pair;
    themePairs.set(key, cached);
  }
  return cached;
}

/** Diff presentation preferences, mapped onto Pierre FileDiff options. */
export interface DiffPreferences {
  diffStyle: "unified" | "split";
  diffIndicators: "bars" | "classic" | "none";
  lineDiffType: "word-alt" | "word" | "char" | "none";
  overflow: "scroll" | "wrap";
  hunkSeparators: "line-info" | "line-info-basic" | "metadata" | "simple";
  lineNumbers: boolean;
  backgrounds: boolean;
}

export const DEFAULT_DIFF_PREFERENCES: DiffPreferences = {
  diffStyle: "unified",
  diffIndicators: "bars",
  lineDiffType: "word-alt",
  overflow: "scroll",
  hunkSeparators: "line-info",
  lineNumbers: true,
  backgrounds: true,
};

type DiffChoiceKey = Exclude<
  keyof DiffPreferences,
  "lineNumbers" | "backgrounds"
>;

/** Allowed values and labels for each enumerated diff preference. */
export const DIFF_CHOICES: {
  [K in DiffChoiceKey]: readonly { value: DiffPreferences[K]; label: string }[];
} = {
  diffStyle: [
    { value: "unified", label: "Unified" },
    { value: "split", label: "Split (side by side)" },
  ],
  diffIndicators: [
    { value: "bars", label: "Bars" },
    { value: "classic", label: "+ and − signs" },
    { value: "none", label: "None" },
  ],
  lineDiffType: [
    { value: "word-alt", label: "Words (joined)" },
    { value: "word", label: "Words" },
    { value: "char", label: "Characters" },
    { value: "none", label: "Off" },
  ],
  overflow: [
    { value: "scroll", label: "Scroll" },
    { value: "wrap", label: "Wrap" },
  ],
  hunkSeparators: [
    { value: "line-info", label: "Unchanged line count" },
    { value: "line-info-basic", label: "Compact line count" },
    { value: "metadata", label: "Hunk header" },
    { value: "simple", label: "Simple divider" },
  ],
};

/**
 * Merge stored diff preferences over the defaults, dropping unknown keys and
 * values so older or edited storage always yields valid Pierre options.
 */
export function resolveDiffPreferences(stored: unknown): DiffPreferences {
  const source =
    stored && typeof stored === "object"
      ? (stored as Record<string, unknown>)
      : {};
  const resolved = { ...DEFAULT_DIFF_PREFERENCES };
  for (const key of Object.keys(DIFF_CHOICES) as DiffChoiceKey[]) {
    const value = source[key];
    if (DIFF_CHOICES[key].some((choice) => choice.value === value)) {
      (resolved as Record<string, unknown>)[key] = value;
    }
  }
  for (const key of ["lineNumbers", "backgrounds"] as const) {
    if (typeof source[key] === "boolean") resolved[key] = source[key];
  }
  return resolved;
}

/** A Hearth token choice; values are CSS so they track light/dark mode. */
export interface InlineCodeColor {
  id: string;
  label: string;
  value: string;
}

export const INLINE_CODE_FOREGROUNDS: readonly InlineCodeColor[] = [
  { id: "fg", label: "Foreground", value: "var(--color-fg)" },
  { id: "fg-soft", label: "Soft foreground", value: "var(--color-fg-soft)" },
  { id: "info", label: "Info", value: "var(--color-info)" },
  { id: "ok", label: "Green", value: "var(--color-ok)" },
  { id: "warn", label: "Amber", value: "var(--color-warn)" },
  { id: "err", label: "Red", value: "var(--color-err)" },
  { id: "violet", label: "Violet", value: "var(--color-step-llm)" },
];

export const INLINE_CODE_BACKGROUNDS: readonly InlineCodeColor[] = [
  { id: "none", label: "None", value: "transparent" },
  { id: "bg-1", label: "Raised surface", value: "var(--color-bg-1)" },
  { id: "bg-2", label: "Sunken surface", value: "var(--color-bg-2)" },
  { id: "bg-3", label: "Strong surface", value: "var(--color-bg-3)" },
  {
    id: "accent-wash",
    label: "Accent wash",
    value: "var(--color-accent-wash)",
  },
  { id: "info-wash", label: "Info wash", value: "var(--color-info-wash)" },
];

/** CSS custom properties that inline code and file references read. */
export const INLINE_CODE_FG_PROPERTY = "--inline-code-fg";
export const INLINE_CODE_BG_PROPERTY = "--inline-code-bg";

/**
 * CSS value for a stored inline color id, or null for the Hearth default
 * (declared in index.css). Unknown ids also resolve to the default.
 */
export function inlineCodeColorValue(
  options: readonly InlineCodeColor[],
  id: string | null | undefined
): string | null {
  return options.find((option) => option.id === id)?.value ?? null;
}

export type CodeHighlighter = "highlights" | "shiki-js";

// Smallest module using a v128 instruction (from wasm-feature-detect).
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8,
  0, 65, 0, 253, 15, 253, 98, 11,
]);

/** Highlights compiles a SIMD WebAssembly module when it is imported. */
export function supportsHighlights(): boolean {
  try {
    return (
      typeof WebAssembly === "object" &&
      typeof WebAssembly.validate === "function" &&
      WebAssembly.validate(SIMD_PROBE)
    );
  } catch {
    return false;
  }
}

/**
 * The one highlighter every Pierre surface uses. Pierre allows a single
 * active highlighter type per thread, so the choice is made once at startup;
 * where WebAssembly SIMD is unavailable both File and FileDiff use Shiki JS.
 */
export const CODE_HIGHLIGHTER: CodeHighlighter = supportsHighlights()
  ? "highlights"
  : "shiki-js";
