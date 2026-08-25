import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "light" | "dark" | "system";

/** Visual treatment for the assistant waiting-state indicator. */
export type ThinkingIndicatorStyle = "classic" | "futuristic";

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
  /** Current assistant thinking indicator style */
  thinkingIndicatorStyle: ThinkingIndicatorStyle;
  /** Current density preference */
  density: DensityPreference;
  /** Application name or path used to open local file references. */
  externalEditor: string;
}

interface UIActions {
  /** Set the theme preference */
  setTheme: (theme: Theme) => void;
  /** Set the assistant thinking indicator style */
  setThinkingIndicatorStyle: (style: ThinkingIndicatorStyle) => void;
  /** Set the density preference */
  setDensity: (density: DensityPreference) => void;
  /** Set the application used to open local file references. */
  setExternalEditor: (externalEditor: string) => void;
}

export type UIStore = UIState & UIActions;

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      theme: "system",
      setTheme: (theme) => set({ theme }),
      thinkingIndicatorStyle: "classic",
      setThinkingIndicatorStyle: (thinkingIndicatorStyle) =>
        set({ thinkingIndicatorStyle }),
      density: "auto",
      setDensity: (density) => set({ density }),
      externalEditor: "",
      setExternalEditor: (externalEditor) => set({ externalEditor }),
    }),
    {
      name: "vertebrae-ui-storage",
      // Only persist UI preferences, not transient state
      partialize: (state) => ({
        theme: state.theme,
        thinkingIndicatorStyle: state.thinkingIndicatorStyle,
        density: state.density,
        externalEditor: state.externalEditor,
      }),
    }
  )
);
