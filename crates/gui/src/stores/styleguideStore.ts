import { create } from "zustand";
import { persist } from "zustand/middleware";

interface StyleguideStore {
  isStyleguideNavVisible: boolean;
  isLiveChatButtonVisible: boolean;
  revealStyleguideNav: () => void;
  hideStyleguideNav: () => void;
  revealChromeShortcuts: () => void;
  hideChromeShortcuts: () => void;
}

export const useStyleguideStore = create<StyleguideStore>()(
  persist(
    (set, get) => ({
      isStyleguideNavVisible: false,
      isLiveChatButtonVisible: false,
      revealStyleguideNav: () => {
        if (get().isStyleguideNavVisible) return;
        set({ isStyleguideNavVisible: true });
      },
      hideStyleguideNav: () => {
        if (!get().isStyleguideNavVisible) return;
        set({ isStyleguideNavVisible: false });
      },
      revealChromeShortcuts: () => {
        set({
          isStyleguideNavVisible: true,
          isLiveChatButtonVisible: true,
        });
      },
      hideChromeShortcuts: () => {
        set({
          isStyleguideNavVisible: false,
          isLiveChatButtonVisible: false,
        });
      },
    }),
    {
      name: "vertebrae-styleguide-storage",
      partialize: (state) => ({
        isStyleguideNavVisible: state.isStyleguideNavVisible,
        isLiveChatButtonVisible: state.isLiveChatButtonVisible,
      }),
    }
  )
);
