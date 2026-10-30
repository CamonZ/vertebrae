import { useEffect, useMemo } from "react";
import { useUIStore } from "../stores/uiStore";
import {
  CODE_HIGHLIGHTER,
  INLINE_CODE_BACKGROUNDS,
  INLINE_CODE_BG_PROPERTY,
  INLINE_CODE_FG_PROPERTY,
  INLINE_CODE_FOREGROUNDS,
  codeThemePair,
  inlineCodeColorValue,
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

/**
 * Pierre theme options for File and FileDiff. `themeType` is pinned to the
 * effective app appearance rather than Pierre's own `system` detection, so a
 * forced light or dark app theme wins over the OS preference.
 */
export function usePierreThemeOptions() {
  const dark = useUIStore((state) => state.codeThemeDark);
  const light = useUIStore((state) => state.codeThemeLight);
  const isLight = useIsLightTheme();
  return useMemo(
    () => ({
      theme: codeThemePair(dark, light),
      themeType: isLight ? ("light" as const) : ("dark" as const),
      preferredHighlighter: CODE_HIGHLIGHTER,
    }),
    [dark, light, isLight]
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
