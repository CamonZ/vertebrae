import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "light" | "dark" | "system";

// Default chat panel height in pixels (approximately 1/3 of a typical screen)
const DEFAULT_CHAT_PANEL_HEIGHT = 320;

interface UIState {
  /** Current theme preference */
  theme: Theme;
  /** Whether the chat panel is open */
  chatPanelOpen: boolean;
  /** Height of the chat panel in pixels */
  chatPanelHeight: number;
}

interface UIActions {
  /** Set the theme preference */
  setTheme: (theme: Theme) => void;
  /** Toggle the chat panel open/closed */
  toggleChatPanel: () => void;
  /** Set the chat panel open state explicitly */
  setChatPanelOpen: (open: boolean) => void;
  /** Set the chat panel height */
  setChatPanelHeight: (height: number) => void;
}

export type UIStore = UIState & UIActions;

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      // Initial state
      theme: "system",
      chatPanelOpen: false,
      chatPanelHeight: DEFAULT_CHAT_PANEL_HEIGHT,

      // Actions
      setTheme: (theme) => set({ theme }),

      toggleChatPanel: () =>
        set((state) => ({ chatPanelOpen: !state.chatPanelOpen })),

      setChatPanelOpen: (open) => set({ chatPanelOpen: open }),

      setChatPanelHeight: (height) => set({ chatPanelHeight: height }),
    }),
    {
      name: "vertebrae-ui-storage",
      // Only persist UI preferences, not transient state
      partialize: (state) => ({
        theme: state.theme,
        chatPanelHeight: state.chatPanelHeight,
      }),
    }
  )
);
