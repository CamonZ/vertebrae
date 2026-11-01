import { useEffect, useMemo, useState } from "react";
import { useUIStore } from "../stores/uiStore";
import {
  CODE_HIGHLIGHTER,
  INLINE_CODE_BACKGROUNDS,
  INLINE_CODE_BG_PROPERTY,
  INLINE_CODE_FG_PROPERTY,
  INLINE_CODE_FOREGROUNDS,
  codeThemePair,
  inlineCodeColorValue,
  pierreSelectionCSS,
  resolveDiffPreferences,
} from "../utils/codeAppearance";
import { useIsLightTheme } from "./useTheme";

/**
 * Apply the inline code preferences as root CSS variables so existing and
 * new inline code and file references update together. Unset variables fall
 * back to the Hearth defaults in index.css. Call once at the app root.
 */
export function useInlineCodeStyle() {
  const foreground = useUIStore((state) => state.inlineCodeForeground);
  const background = useUIStore((state) => state.inlineCodeBackground);

  useEffect(() => {
    const style = document.documentElement.style;
    const apply = (property: string, value: string | null) => {
      if (value) style.setProperty(property, value);
      else style.removeProperty(property);
    };
    apply(
      INLINE_CODE_FG_PROPERTY,
      inlineCodeColorValue(INLINE_CODE_FOREGROUNDS, foreground)
    );
    apply(
      INLINE_CODE_BG_PROPERTY,
      inlineCodeColorValue(INLINE_CODE_BACKGROUNDS, background)
    );
  }, [foreground, background]);
}

/** Theme name to its selection colour, `null` when it defines none. */
const themeSelections = new Map<string, string | null>();

/**
 * The selection colour a code theme defines. Resolved through Pierre, which
 * is imported on demand so it stays out of the main chunk; `null` until then
 * and for themes without one.
 */
function useThemeSelection(name: string): string | null {
  const [resolved, setResolved] = useState<{
    name: string;
    color: string | null;
  } | null>(null);
  const cached = themeSelections.get(name);

  useEffect(() => {
    if (themeSelections.has(name)) return;
    let cancelled = false;
    import("@pierre/diffs")
      .then(({ getResolvedOrResolveTheme }) =>
        getResolvedOrResolveTheme(name, CODE_HIGHLIGHTER)
      )
      .then(
        (theme) => theme.colors?.["editor.selectionBackground"] || null,
        () => null
      )
      .then((color) => {
        themeSelections.set(name, color);
        if (!cancelled) setResolved({ name, color });
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (cached !== undefined) return cached;
  return resolved?.name === name ? resolved.color : null;
}

/**
 * Pierre theme options for File and FileDiff. `themeType` is pinned to the
 * effective app appearance rather than Pierre's own `system` detection, so a
 * forced light or dark app theme wins over the OS preference. Every view
 * shares the active theme's selection colour.
 */
export function usePierreThemeOptions() {
  const dark = useUIStore((state) => state.codeThemeDark);
  const light = useUIStore((state) => state.codeThemeLight);
  const isLight = useIsLightTheme();
  const theme = codeThemePair(dark, light);
  const selection = useThemeSelection(isLight ? theme.light : theme.dark);
  return useMemo(
    () => ({
      theme,
      themeType: isLight ? ("light" as const) : ("dark" as const),
      preferredHighlighter: CODE_HIGHLIGHTER,
      unsafeCSS: pierreSelectionCSS(selection),
    }),
    [theme, isLight, selection]
  );
}

/** Pierre FileDiff options: the shared theme plus the diff preferences. */
export function usePierreDiffOptions() {
  const themeOptions = usePierreThemeOptions();
  const preferences = useUIStore((state) => state.diffPreferences);
  return useMemo(() => {
    const { lineNumbers, backgrounds, ...choices } =
      resolveDiffPreferences(preferences);
    return {
      ...themeOptions,
      ...choices,
      disableLineNumbers: !lineNumbers,
      disableBackground: !backgrounds,
    };
  }, [themeOptions, preferences]);
}
