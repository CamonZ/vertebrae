import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "light" | "dark" | "system";

interface UIState {
  /** Current theme preference */
  theme: Theme;
  /** Whether the Claude chat sidebar is open */
  claudeSidebarOpen: boolean;
}

interface UIActions {
  /** Set the theme preference */
  setTheme: (theme: Theme) => void;
  /** Toggle the Claude chat sidebar open/closed */
  toggleClaudeSidebar: () => void;
  /** Set the Claude sidebar open state explicitly */
  setClaudeSidebarOpen: (open: boolean) => void;
}

export type UIStore = UIState & UIActions;

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      // Initial state
      theme: "system",
      claudeSidebarOpen: false,

      // Actions
      setTheme: (theme) => set({ theme }),

      toggleClaudeSidebar: () =>
        set((state) => ({ claudeSidebarOpen: !state.claudeSidebarOpen })),

      setClaudeSidebarOpen: (open) => set({ claudeSidebarOpen: open }),
    }),
    {
      name: "vertebrae-ui-storage",
      // Only persist UI preferences, not transient state
      partialize: (state) => ({
        theme: state.theme,
      }),
    }
  )
);
