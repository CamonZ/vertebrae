import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "light" | "dark" | "system";

/**
 * Density preference for the typography scale.
 * - 'auto':        Let useDensity() decide based on scaleFactor + window width.
 * - 'comfortable': Pin to comfortable mode (lifts small tokens ~1 step).
 * - 'default':     Pin to base token values (no data-density attribute).
 * - 'compact':     Pin to compact mode (shrinks small tokens ~1 step).
 */
export type DensityPreference = "auto" | "comfortable" | "default" | "compact";

interface UIState {
  /** Current theme preference */
  theme: Theme;
  /** Current density preference */
  density: DensityPreference;
}

interface UIActions {
  /** Set the theme preference */
  setTheme: (theme: Theme) => void;
  /** Set the density preference */
  setDensity: (density: DensityPreference) => void;
}

export type UIStore = UIState & UIActions;

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      theme: "system",
      setTheme: (theme) => set({ theme }),
      density: "auto",
      setDensity: (density) => set({ density }),
    }),
    {
      name: "vertebrae-ui-storage",
      // Only persist UI preferences, not transient state
      partialize: (state) => ({
        theme: state.theme,
        density: state.density,
      }),
    }
  )
);
