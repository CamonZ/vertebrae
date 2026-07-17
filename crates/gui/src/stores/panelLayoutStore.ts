import { create } from "zustand";

/** Mirrors the shared `--s-3` inset/gap used by floating side panels. */
export const SIDE_PANEL_INSET_PX = 12;
export const SIDE_PANEL_GAP_PX = 12;

export interface ChatPanelLayout {
  /** True while the chat surface is visible, including its exit animation. */
  isPresent: boolean;
  /** Width currently painted by the chat surface. */
  renderedWidth: number;
  /** Wide chat overlays detail panels instead of reserving adjacent space. */
  isMaximized: boolean;
}

interface PanelLayoutState {
  chat: ChatPanelLayout;
  setChatLayout: (layout: ChatPanelLayout) => void;
  clearChatLayout: () => void;
  /** Test seam. */
  reset: () => void;
}

const EMPTY_CHAT_LAYOUT: ChatPanelLayout = {
  isPresent: false,
  renderedWidth: 0,
  isMaximized: false,
};

/**
 * Shares geometry between the globally mounted chat and page-local detail
 * panels. Focus order intentionally stays in panelFocusStore; this store only
 * describes the space occupied by the chat surface.
 */
export const usePanelLayoutStore = create<PanelLayoutState>((set) => ({
  chat: EMPTY_CHAT_LAYOUT,
  setChatLayout: (chat) => set({ chat }),
  clearChatLayout: () => set({ chat: EMPTY_CHAT_LAYOUT }),
  reset: () => set({ chat: EMPTY_CHAT_LAYOUT }),
}));
