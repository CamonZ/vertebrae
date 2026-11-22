import { useCallback, useEffect, useState } from "react";

/** The narrowest chat the expanded workspace keeps beside the history. */
export const MIN_CHAT_PANE_WIDTH = 360;
export const HISTORY_WIDTH_STORAGE_KEY = "chat-window-manager-history-width";
export const MIN_HISTORY_WIDTH = 272;
export const MAX_HISTORY_WIDTH = 640;
export const DEFAULT_HISTORY_WIDTH = 272;
export const HISTORY_RESIZE_STEP = 16;

export function clampHistoryWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_HISTORY_WIDTH;

  return Math.min(MAX_HISTORY_WIDTH, Math.max(MIN_HISTORY_WIDTH, width));
}

/**
 * Returns the largest history width that leaves the chat at least its
 * supported minimum width.
 */
export function maxHistoryWidthForLayout(renderedPanelWidth: number): number {
  const availableWidth = Number.isFinite(renderedPanelWidth)
    ? renderedPanelWidth - MIN_CHAT_PANE_WIDTH
    : Number.NaN;

  return clampHistoryWidth(availableWidth);
}

export function clampHistoryWidthForLayout(
  width: number,
  renderedPanelWidth: number
): number {
  return Math.min(
    maxHistoryWidthForLayout(renderedPanelWidth),
    clampHistoryWidth(width)
  );
}

function readPersistedHistoryWidth(): number {
  if (typeof window === "undefined") return DEFAULT_HISTORY_WIDTH;

  try {
    const stored = window.localStorage.getItem(HISTORY_WIDTH_STORAGE_KEY);

    if (!stored || stored.trim() === "") return DEFAULT_HISTORY_WIDTH;

    const parsed = Number(stored);

    return Number.isFinite(parsed)
      ? clampHistoryWidth(parsed)
      : DEFAULT_HISTORY_WIDTH;
  } catch {
    // Storage can be unavailable in private, restricted, or test contexts.
    return DEFAULT_HISTORY_WIDTH;
  }
}

interface UseChatHistoryPanelLayoutResult {
  historyWidth: number;
  resizeHistoryWidth: (nextWidth: number) => void;
}

export function useChatHistoryPanelLayout(): UseChatHistoryPanelLayoutResult {
  const [historyWidth, setHistoryWidth] = useState(readPersistedHistoryWidth);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(
        HISTORY_WIDTH_STORAGE_KEY,
        String(historyWidth)
      );
    } catch {
      // A persisted width is an enhancement; layout remains usable without it.
    }
  }, [historyWidth]);

  const resizeHistoryWidth = useCallback((nextWidth: number) => {
    setHistoryWidth(clampHistoryWidth(nextWidth));
  }, []);

  return { historyWidth, resizeHistoryWidth };
}
