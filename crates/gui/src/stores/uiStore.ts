import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_GATE_STEERING_THRESHOLDS,
  type GateSteeringThresholds,
} from "../utils/gateDraft";
import {
  DEFAULT_CODE_THEMES,
  DEFAULT_DIFF_PREFERENCES,
  resolveDiffPreferences,
  type ColorScheme,
  type DiffPreferences,
} from "../utils/codeAppearance";

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
  /** Stalled user turns before a gate chat is steered back to its draft. */
  gateSteeringThresholds: GateSteeringThresholds;
  /** Syntax theme for code blocks and diffs in dark mode. */
  codeThemeDark: string;
  /** Syntax theme for code blocks and diffs in light mode. */
  codeThemeLight: string;
  /** Presentation options for Pierre diffs. */
  diffPreferences: DiffPreferences;
  /** Inline code foreground choice; null uses the Hearth default. */
  inlineCodeForeground: string | null;
  /** Inline code background choice; null uses the Hearth default. */
  inlineCodeBackground: string | null;
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
  /** Set when stalled gate chats are steered. */
  setGateSteeringThresholds: (thresholds: GateSteeringThresholds) => void;
  /** Set the code and diff theme used in one appearance. */
  setCodeTheme: (scheme: ColorScheme, name: string) => void;
  /** Update some diff presentation options. */
  setDiffPreferences: (preferences: Partial<DiffPreferences>) => void;
  /** Restore the default diff presentation. */
  resetDiffPreferences: () => void;
  /** Set the inline code foreground choice. */
  setInlineCodeForeground: (id: string | null) => void;
  /** Set the inline code background choice. */
  setInlineCodeBackground: (id: string | null) => void;
  /** Restore the Hearth inline code styling. */
  resetInlineCodeStyle: () => void;
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
      gateSteeringThresholds: DEFAULT_GATE_STEERING_THRESHOLDS,
      setGateSteeringThresholds: (gateSteeringThresholds) =>
        set({ gateSteeringThresholds }),
      codeThemeDark: DEFAULT_CODE_THEMES.dark,
      codeThemeLight: DEFAULT_CODE_THEMES.light,
      setCodeTheme: (scheme, name) =>
        set(
          scheme === "dark" ? { codeThemeDark: name } : { codeThemeLight: name }
        ),
      diffPreferences: DEFAULT_DIFF_PREFERENCES,
      setDiffPreferences: (preferences) =>
        set((state) => ({
          diffPreferences: { ...state.diffPreferences, ...preferences },
        })),
      resetDiffPreferences: () =>
        set({ diffPreferences: DEFAULT_DIFF_PREFERENCES }),
      inlineCodeForeground: null,
      setInlineCodeForeground: (inlineCodeForeground) =>
        set({ inlineCodeForeground }),
      inlineCodeBackground: null,
      setInlineCodeBackground: (inlineCodeBackground) =>
        set({ inlineCodeBackground }),
      resetInlineCodeStyle: () =>
        set({ inlineCodeForeground: null, inlineCodeBackground: null }),
    }),
    {
      name: "vertebrae-ui-storage",
      // Only persist UI preferences, not transient state
      partialize: (state) => ({
        theme: state.theme,
        thinkingIndicatorStyle: state.thinkingIndicatorStyle,
        density: state.density,
        externalEditor: state.externalEditor,
        gateSteeringThresholds: state.gateSteeringThresholds,
        codeThemeDark: state.codeThemeDark,
        codeThemeLight: state.codeThemeLight,
        diffPreferences: state.diffPreferences,
        inlineCodeForeground: state.inlineCodeForeground,
        inlineCodeBackground: state.inlineCodeBackground,
      }),
      // Fill in diff options added after the preferences were saved.
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<UIState>;
        return {
          ...current,
          ...stored,
          diffPreferences: resolveDiffPreferences(stored.diffPreferences),
        };
      },
    }
  )
);
