import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "light" | "dark" | "system";

// Default chat panel width in pixels (approximately 1/4 of a 1920px screen)
const DEFAULT_CHAT_PANEL_WIDTH = 480;

interface UIState {
  /** Current theme preference */
  theme: Theme;
  /** Whether the chat panel is open */
  chatPanelOpen: boolean;
  /** Width of the chat panel in pixels */
  chatPanelWidth: number;
}

interface UIActions {
  /** Set the theme preference */
  setTheme: (theme: Theme) => void;
  /** Toggle the chat panel open/closed */
  toggleChatPanel: () => void;
  /** Set the chat panel open state explicitly */
  setChatPanelOpen: (open: boolean) => void;
  /** Set the chat panel width */
  setChatPanelWidth: (width: number) => void;
}

export type UIStore = UIState & UIActions;

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      // Initial state
      theme: "system",
      chatPanelOpen: false,
      chatPanelWidth: DEFAULT_CHAT_PANEL_WIDTH,

      // Actions
      setTheme: (theme) => set({ theme }),

      toggleChatPanel: () =>
        set((state) => ({ chatPanelOpen: !state.chatPanelOpen })),

      setChatPanelOpen: (open) => set({ chatPanelOpen: open }),

      setChatPanelWidth: (width) => set({ chatPanelWidth: width }),
    }),
    {
      name: "vertebrae-ui-storage",
      // Only persist UI preferences, not transient state
      partialize: (state) => ({
        theme: state.theme,
        chatPanelWidth: state.chatPanelWidth,
      }),
    }
  )
);
