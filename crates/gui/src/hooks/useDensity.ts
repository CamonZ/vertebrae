import { useEffect } from "react";
import { useUIStore } from "../stores/uiStore";

/**
 * Hook that manages density application based on user preference, window width,
 * and display scale factor (Retina vs non-Retina).
 *
 * Handles four modes:
 * - 'auto':        Applies "comfortable" when scaleFactor < 1.5 OR innerWidth < 1400,
 *                  otherwise removes the attribute (default density).
 * - 'comfortable': Always sets data-density="comfortable" (lifts small tokens).
 * - 'default':     Clears data-density (no override, tokens at their base values).
 * - 'compact':     Always sets data-density="compact" (shrinks small tokens).
 *
 * The data-density attribute on <html> is consumed by :root[data-density] CSS blocks
 * defined in index.css. No attribute = default token values.
 *
 * Guard: scaleFactor() is a Tauri-only API; in vitest / browser-dev the call is
 * wrapped in try/catch and falls back to 1 (treated as non-Retina → comfortable
 * unless innerWidth overrides).
 *
 * This hook should be called once at the app root level (alongside useTheme).
 */
export function useDensity() {
  const density = useUIStore((state) => state.density);

  useEffect(() => {
    const root = document.documentElement;

    function setDensityAttr(value: "comfortable" | "compact" | null) {
      if (value === null) {
        root.removeAttribute("data-density");
      } else {
        root.setAttribute("data-density", value);
      }
    }

    // Explicit pinned preferences — set once and done.
    if (density === "comfortable") {
      setDensityAttr("comfortable");
      return;
    }

    if (density === "compact") {
      setDensityAttr("compact");
      return;
    }

    if (density === "default") {
      setDensityAttr(null);
      return;
    }

    // density === "auto": evaluate rule and re-evaluate on resize.
    async function evaluate() {
      let scaleFactor = 1;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        scaleFactor = await getCurrentWindow().scaleFactor();
      } catch {
        // Non-Tauri context (vitest, browser dev): fall back to 1 (non-Retina).
        scaleFactor = 1;
      }

      const isComfortable =
        scaleFactor < 1.5 || window.innerWidth < 1400;

      setDensityAttr(isComfortable ? "comfortable" : null);
    }

    evaluate();

    function handleResize() {
      evaluate();
    }

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [density]);
}
