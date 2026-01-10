import { useEffect } from 'react';
import { useUIStore } from '../stores/uiStore';

/**
 * Hook that manages theme application based on user preference and system settings.
 *
 * Handles three modes:
 * - 'light': Always light mode
 * - 'dark': Always dark mode
 * - 'system': Follows system preference via matchMedia
 *
 * This hook should be called once at the app root level.
 */
export function useTheme() {
  const theme = useUIStore((state) => state.theme);

  useEffect(() => {
    const root = document.documentElement;

    /**
     * Apply the dark class to the html element based on the effective theme.
     */
    function applyTheme(isDark: boolean) {
      if (isDark) {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
    }

    // Handle explicit light/dark preferences
    if (theme === 'light') {
      applyTheme(false);
      return;
    }

    if (theme === 'dark') {
      applyTheme(true);
      return;
    }

    // Handle 'system' preference - use matchMedia to detect and track system preference
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    // Apply current system preference
    applyTheme(mediaQuery.matches);

    // Listen for system preference changes
    function handleChange(event: MediaQueryListEvent) {
      applyTheme(event.matches);
    }

    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, [theme]);
}
