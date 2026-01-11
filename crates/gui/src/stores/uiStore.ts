import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "light" | "dark" | "system";

interface UIState {
  /** Whether the sidebar is collapsed */
  sidebarCollapsed: boolean;
  /** Current theme preference */
  theme: Theme;
}

interface UIActions {
  /** Toggle the sidebar collapsed state */
  toggleSidebar: () => void;
  /** Set the sidebar collapsed state explicitly */
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** Set the theme preference */
  setTheme: (theme: Theme) => void;
}

export type UIStore = UIState & UIActions;

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      // Initial state
      sidebarCollapsed: false,
      theme: "system",

      // Actions
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

      setTheme: (theme) => set({ theme }),
    }),
    {
      name: "vertebrae-ui-storage",
      // Only persist UI preferences, not transient state
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        theme: state.theme,
      }),
    }
  )
);
