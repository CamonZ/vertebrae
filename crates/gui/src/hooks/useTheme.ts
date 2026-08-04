import { useEffect, useState } from "react";
import { useUIStore } from "../stores/uiStore";

/**
 * Hook that manages theme application based on user preference and system settings.
 *
 * Handles three modes:
 * - 'light': Force light mode
 * - 'dark': Force dark mode (default aesthetic for Vertebrae)
 * - 'system': Follows system preference via matchMedia
 *
 * The design system defaults to dark mode (no class needed).
 * Light mode is activated by adding the 'light' class to <html>.
 *
 * This hook should be called once at the app root level.
 */
export function useTheme() {
  const theme = useUIStore((state) => state.theme);

  useEffect(() => {
    const root = document.documentElement;

    /**
     * Apply the light class to the html element.
     * Dark mode is the default - light mode is opt-in.
     */
    function applyTheme(isLight: boolean) {
      if (isLight) {
        root.classList.add("light");
        root.classList.remove("dark");
      } else {
        root.classList.remove("light");
        root.classList.add("dark");
      }
    }

    // Handle explicit light/dark preferences
    if (theme === "light") {
      applyTheme(true);
      return;
    }

    if (theme === "dark") {
      applyTheme(false);
      return;
    }

    // Handle 'system' preference - use matchMedia to detect and track system preference
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    // Apply current system preference (inverted - dark by default)
    applyTheme(!mediaQuery.matches);

    // Listen for system preference changes
    function handleChange(event: MediaQueryListEvent) {
      applyTheme(!event.matches);
    }

    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [theme]);
}

/**
 * Return the effective light-mode state for components with inline theme data.
 * The root theme hook owns the DOM class; this hook follows the same store and
 * system preference so inline renderer styles update without DOM observers.
 */
export function useIsLightTheme() {
  const theme = useUIStore((state) => state.theme);
  const [isLight, setIsLight] = useState(() =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    if (theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setIsLight(!mediaQuery.matches);

    update();
    mediaQuery.addEventListener("change", update);

    return () => mediaQuery.removeEventListener("change", update);
  }, [theme]);

  return theme === "light" || (theme === "system" && isLight);
}
