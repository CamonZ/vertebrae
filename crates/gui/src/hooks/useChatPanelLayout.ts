import { useCallback, useEffect, useRef, useState } from "react";
import { SIDE_PANEL_INSET_PX } from "../stores/panelLayoutStore";

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
  const [isMaximized, setIsMaximized] = useState(false);
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

  const toggleMaximized = useCallback(() => {
    if (isMaximized) {
      unsplitPanes();
      setPanelWidth(restoredPanelWidth);
      setIsMaximized(false);
      return;
    }
    setRestoredPanelWidth(panelWidth);
    setMaximizedWidth(computeMaximizedWidth());
    setIsMaximized(true);
  }, [
    computeMaximizedWidth,
    isMaximized,
    panelWidth,
    restoredPanelWidth,
    unsplitPanes,
  ]);

  const resizePanel = useCallback(
    (nextWidth: number) => {
      const width = Math.min(
        MAX_PANEL_WIDTH,
        Math.max(MIN_PANEL_WIDTH, nextWidth)
      );
      unsplitPanes();
      setIsMaximized(false);
      setRestoredPanelWidth(width);
      setPanelWidth(width);
    },
    [unsplitPanes]
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

  /** Restore the pre-maximize width and unsplit after wide chat is dismissed. */
  const collapseMaximized = useCallback(() => {
    if (isMaximized) {
      unsplitPanes();
      setPanelWidth(restoredPanelWidth);
      setIsMaximized(false);
    }
  }, [isMaximized, restoredPanelWidth, unsplitPanes]);

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
    resizePanel,
    startResizeDrag,
    collapseMaximized,
  };
}
