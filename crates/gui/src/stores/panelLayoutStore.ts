import { create } from "zustand";

/** Mirrors the shared `--s-3` inset/gap used by floating side panels. */
export const SIDE_PANEL_INSET_PX = 12;
export const SIDE_PANEL_GAP_PX = 12;
/** Left inset used when maximized chat is the notification overlay surface. */
export const SIDE_PANEL_MAXIMIZED_LEFT_INSET_PX = 60;

export interface ChatPanelLayout {
  /** True while the chat surface is visible, including its exit animation. */
  isPresent: boolean;
  /** Width currently painted by the chat surface. */
  renderedWidth: number;
  /** Wide chat overlays detail panels instead of reserving adjacent space. */
  isMaximized: boolean;
}
export interface DetailPanelLayout {
  isPresent: boolean;
  renderedWidth: number;
}

/** Numeric geometry published by every floating side panel. */
export interface RegisteredPanelLayout {
  isPresent: boolean;
  renderedWidth: number;
  /** Distance from the panel's right edge to the shared right inset. */
  rightOffset: number;
  isMaximized?: boolean;
  /** Optional left inset for panels that intentionally overlay maximized chat. */
  leftOffset?: number;
}

export type NotificationPanelPlacement =
  | {
      mode: "right" | "left-of-leftmost" | "overlay";
      rightOffset: number;
      leftmostPanelId?: string;
    }
  | {
      mode: "maximized-chat";
      leftOffset: number;
      leftmostPanelId: "chat";
    };

interface PanelLayoutState {
  chat: ChatPanelLayout;
  taskDetail: DetailPanelLayout;
  panels: Record<string, RegisteredPanelLayout>;
  setChatLayout: (layout: ChatPanelLayout) => void;
  clearChatLayout: () => void;
  setTaskDetailLayout: (layout: DetailPanelLayout) => void;
  clearTaskDetailLayout: () => void;
  setPanelLayout: (id: string, layout: RegisteredPanelLayout) => void;
  clearPanelLayout: (id: string) => void;
  /** Test seam. */
  reset: () => void;
}

const EMPTY_CHAT_LAYOUT: ChatPanelLayout = {
  isPresent: false,
  renderedWidth: 0,
  isMaximized: false,
};
const EMPTY_DETAIL_LAYOUT: DetailPanelLayout = {
  isPresent: false,
  renderedWidth: 0,
};

const toRegisteredLayout = (
  layout: ChatPanelLayout | DetailPanelLayout,
  rightOffset: number,
  isMaximized = false
): RegisteredPanelLayout => ({
  isPresent: layout.isPresent,
  renderedWidth: layout.renderedWidth,
  rightOffset,
  isMaximized,
  ...(isMaximized ? { leftOffset: SIDE_PANEL_MAXIMIZED_LEFT_INSET_PX } : {}),
});

/**
 * Shares geometry between the globally mounted chat and page-local detail
 * panels. Focus order intentionally stays in panelFocusStore; this store only
 * describes the space occupied by side-panel surfaces.
 */
export const usePanelLayoutStore = create<PanelLayoutState>((set) => ({
  chat: EMPTY_CHAT_LAYOUT,
  taskDetail: EMPTY_DETAIL_LAYOUT,
  panels: {},
  setChatLayout: (chat) =>
    set((state) => ({
      chat,
      panels: {
        ...state.panels,
        chat: toRegisteredLayout(chat, 0, chat.isMaximized),
      },
    })),
  clearChatLayout: () =>
    set((state) => {
      const panels = { ...state.panels };
      delete panels.chat;
      return { chat: EMPTY_CHAT_LAYOUT, panels };
    }),
  setTaskDetailLayout: (taskDetail) =>
    set((state) => ({
      taskDetail,
      panels: {
        ...state.panels,
        "task-detail": toRegisteredLayout(taskDetail, 0),
      },
    })),
  clearTaskDetailLayout: () =>
    set((state) => {
      const panels = { ...state.panels };
      delete panels["task-detail"];
      return { taskDetail: EMPTY_DETAIL_LAYOUT, panels };
    }),
  setPanelLayout: (id, layout) =>
    set((state) => ({
      panels: { ...state.panels, [id]: layout },
      ...(id === "task-detail"
        ? {
            taskDetail: {
              isPresent: layout.isPresent,
              renderedWidth: layout.renderedWidth,
            },
          }
        : {}),
    })),
  clearPanelLayout: (id) =>
    set((state) => {
      const panels = { ...state.panels };
      delete panels[id];
      return {
        panels,
        ...(id === "task-detail" ? { taskDetail: EMPTY_DETAIL_LAYOUT } : {}),
      };
    }),
  reset: () =>
    set({
      chat: EMPTY_CHAT_LAYOUT,
      taskDetail: EMPTY_DETAIL_LAYOUT,
      panels: {},
    }),
}));

/**
 * Select where the notifications panel should render relative to the current
 * side-panel geometry. Existing panels keep their widths; only notifications
 * changes placement when the available horizontal space changes.
 */
export function getNotificationPanelPlacement(
  panels: Record<string, RegisteredPanelLayout>,
  viewportWidth: number,
  notificationWidth: number
): NotificationPanelPlacement {
  const visiblePanels = Object.entries(panels).filter(
    ([id, layout]) =>
      id !== "notifications" && layout.isPresent && layout.renderedWidth > 0
  );

  if (visiblePanels.length === 0) {
    return { mode: "right", rightOffset: 0 };
  }

  const chat = panels.chat;
  if (chat?.isPresent && chat.isMaximized) {
    return {
      mode: "maximized-chat",
      leftOffset: chat.leftOffset ?? SIDE_PANEL_MAXIMIZED_LEFT_INSET_PX,
      leftmostPanelId: "chat",
    };
  }

  const [leftmostPanelId, leftmostPanel] = visiblePanels.reduce(
    (leftmost, current) => {
      const leftmostLeft =
        viewportWidth -
        SIDE_PANEL_INSET_PX -
        leftmost[1].rightOffset -
        leftmost[1].renderedWidth;
      const currentLeft =
        viewportWidth -
        SIDE_PANEL_INSET_PX -
        current[1].rightOffset -
        current[1].renderedWidth;
      return currentLeft < leftmostLeft ? current : leftmost;
    }
  );
  const leftmostLeft =
    viewportWidth -
    SIDE_PANEL_INSET_PX -
    leftmostPanel.rightOffset -
    leftmostPanel.renderedWidth;
  const leftOfLeftmostOffset =
    leftmostPanel.rightOffset + leftmostPanel.renderedWidth + SIDE_PANEL_GAP_PX;
  const hasRoomToTheLeft =
    leftmostLeft - SIDE_PANEL_GAP_PX - notificationWidth >= SIDE_PANEL_INSET_PX;

  return {
    mode: hasRoomToTheLeft ? "left-of-leftmost" : "overlay",
    rightOffset: hasRoomToTheLeft
      ? leftOfLeftmostOffset
      : leftmostPanel.rightOffset,
    leftmostPanelId,
  };
}
