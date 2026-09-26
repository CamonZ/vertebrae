import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { SIDE_PANEL_INSET_PX } from "../stores/panelLayoutStore";
import { useShellStore } from "../stores/shellStore";

/** Floating chat-panel width: persistence key and clamp bounds (px). Mirrors
 * the task-detail panel's horizontal resize (TaskDetailPanel.tsx). */
export const WIDTH_STORAGE_KEY = "chat-window-manager-width";
export const MIN_PANEL_WIDTH = 320;
export const MAX_PANEL_WIDTH = 760;
export const DEFAULT_PANEL_WIDTH = 384;
export const DEFAULT_PANEL_LEFT_INSET = 60;
export const DEFAULT_PANEL_RIGHT_INSET = SIDE_PANEL_INSET_PX;
/** Keyboard resize step (px) for the drag handle. */
export const RESIZE_STEP = 16;

interface UseChatPanelLayoutOptions {
  /** When the panel closes while maximized, the split panes should be unsplit. */
  unsplitPanes: () => void;
}

interface UseChatPanelLayoutResult {
  panelRef: React.RefObject<HTMLDivElement | null>;
  panelWidth: number;
  restoredPanelWidth: number;
  maximizedWidth: number;
  isMaximized: boolean;
  isResizing: boolean;
  renderedPanelWidth: number;
  setPanelWidth: React.Dispatch<React.SetStateAction<number>>;
  setIsResizing: React.Dispatch<React.SetStateAction<boolean>>;
  computeMaximizedWidth: () => number;
  toggleMaximized: () => void;
  toggleFromShortcut: () => void;
  dismissMaximized: () => void;
  resizePanel: (nextWidth: number) => void;
  startResizeDrag: () => void;
  collapseMaximized: () => void;
}

/**
 * Panel width / maximize / resize-drag state machine for the floating chat
 * panel. The panel is right-anchored, so a drag on its left edge widens it as
 * the cursor moves left. We measure the panel's fixed right edge from the DOM
 * rather than assuming the inset value.
 */
export function useChatPanelLayout({
  unsplitPanes,
}: UseChatPanelLayoutOptions): UseChatPanelLayoutResult {
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
    const stored = parseInt(localStorage.getItem(WIDTH_STORAGE_KEY) ?? "", 10);
    return Number.isNaN(stored)
      ? DEFAULT_PANEL_WIDTH
      : Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, stored));
  });
  const [restoredPanelWidth, setRestoredPanelWidth] = useState(panelWidth);
  const chatPanelPresentation = useShellStore(
    (state) => state.chatPanelPresentation
  );
  const setChatPanelPresentation = useShellStore(
    (state) => state.setChatPanelPresentation
  );
  const isMaximized = chatPanelPresentation === "expanded";
  const [maximizedWidth, setMaximizedWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && !isMaximized) {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(panelWidth));
    }
  }, [isMaximized, panelWidth]);

  const computeMaximizedWidth = useCallback(() => {
    if (typeof window === "undefined") return MAX_PANEL_WIDTH;
    const measuredRightEdge = panelRef.current?.getBoundingClientRect().right;
    const rightEdge =
      measuredRightEdge && measuredRightEdge > 0
        ? measuredRightEdge
        : window.innerWidth - DEFAULT_PANEL_RIGHT_INSET;
    return Math.max(MIN_PANEL_WIDTH, rightEdge - DEFAULT_PANEL_LEFT_INSET);
  }, []);

  // The sticky rail affordance resumes expanded chat from outside this hook.
  // Measure before paint so the resumed panel does not flash at compact width.
  useLayoutEffect(() => {
    if (isMaximized) setMaximizedWidth(computeMaximizedWidth());
  }, [computeMaximizedWidth, isMaximized]);

  const toggleMaximized = useCallback(() => {
    if (isMaximized) {
      unsplitPanes();
      setPanelWidth(restoredPanelWidth);
      setChatPanelPresentation("compact");
      return;
    }
    if (chatPanelPresentation === "compact") setRestoredPanelWidth(panelWidth);
    setMaximizedWidth(computeMaximizedWidth());
    setChatPanelPresentation("expanded");
  }, [
    chatPanelPresentation,
    computeMaximizedWidth,
    isMaximized,
    panelWidth,
    restoredPanelWidth,
    setChatPanelPresentation,
    unsplitPanes,
  ]);

  const dismissMaximized = useCallback(() => {
    if (chatPanelPresentation === "compact") return;
    unsplitPanes();
    setPanelWidth(restoredPanelWidth);
    setChatPanelPresentation("compact");
  }, [
    chatPanelPresentation,
    restoredPanelWidth,
    setChatPanelPresentation,
    unsplitPanes,
  ]);

  const toggleFromShortcut = useCallback(() => {
    if (chatPanelPresentation !== "compact") {
      dismissMaximized();
      return;
    }
    toggleMaximized();
  }, [chatPanelPresentation, dismissMaximized, toggleMaximized]);

  const resizePanel = useCallback(
    (nextWidth: number) => {
      const width = Math.min(
        MAX_PANEL_WIDTH,
        Math.max(MIN_PANEL_WIDTH, nextWidth)
      );
      unsplitPanes();
      setChatPanelPresentation("compact");
      setRestoredPanelWidth(width);
      setPanelWidth(width);
    },
    [setChatPanelPresentation, unsplitPanes]
  );

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (event: MouseEvent) => {
      const measuredRightEdge = panelRef.current?.getBoundingClientRect().right;
      const rightEdge =
        measuredRightEdge && measuredRightEdge > 0
          ? measuredRightEdge
          : window.innerWidth - DEFAULT_PANEL_RIGHT_INSET;
      resizePanel(rightEdge - event.clientX);
    };
    const onUp = () => setIsResizing(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing, resizePanel]);

  useEffect(() => {
    if (!isMaximized) return;
    const updateMaximizedWidth = () =>
      setMaximizedWidth(computeMaximizedWidth());
    updateMaximizedWidth();
    window.addEventListener("resize", updateMaximizedWidth);
    return () => window.removeEventListener("resize", updateMaximizedWidth);
  }, [computeMaximizedWidth, isMaximized]);

  /** Restore the normal width and discard split layout after dismissal. */
  const collapseMaximized = useCallback(() => {
    if (chatPanelPresentation !== "compact") {
      unsplitPanes();
      setPanelWidth(restoredPanelWidth);
      setChatPanelPresentation("compact");
    }
  }, [
    chatPanelPresentation,
    restoredPanelWidth,
    setChatPanelPresentation,
    unsplitPanes,
  ]);

  const startResizeDrag = useCallback(() => setIsResizing(true), []);

  return {
    panelRef,
    panelWidth,
    restoredPanelWidth,
    maximizedWidth,
    isMaximized,
    isResizing,
    renderedPanelWidth: isMaximized ? maximizedWidth : panelWidth,
    setPanelWidth,
    setIsResizing,
    computeMaximizedWidth,
    toggleMaximized,
    toggleFromShortcut,
    dismissMaximized,
    resizePanel,
    startResizeDrag,
    collapseMaximized,
  };
}
