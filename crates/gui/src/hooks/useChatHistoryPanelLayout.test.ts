import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_WIDTH,
  HISTORY_WIDTH_STORAGE_KEY,
  MAX_HISTORY_WIDTH,
  MIN_HISTORY_WIDTH,
  clampHistoryWidthForLayout,
  maxHistoryWidthForLayout,
  useChatHistoryPanelLayout,
} from "./useChatHistoryPanelLayout";

describe("useChatHistoryPanelLayout", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to the minimum width when nothing is persisted", () => {
    const { result } = renderHook(() => useChatHistoryPanelLayout());

    expect(result.current.historyWidth).toBe(DEFAULT_HISTORY_WIDTH);
  });

  it("restores and persists a selected width across remounts", () => {
    const first = renderHook(() => useChatHistoryPanelLayout());

    act(() => first.result.current.resizeHistoryWidth(348));

    expect(localStorage.getItem(HISTORY_WIDTH_STORAGE_KEY)).toBe("348");
    first.unmount();

    const second = renderHook(() => useChatHistoryPanelLayout());
    expect(second.result.current.historyWidth).toBe(348);
  });

  it.each([
    ["below the lower bound", "100", MIN_HISTORY_WIDTH],
    ["above the upper bound", "999", MAX_HISTORY_WIDTH],
    ["malformed", "not-a-width", DEFAULT_HISTORY_WIDTH],
    ["non-finite", "Infinity", DEFAULT_HISTORY_WIDTH],
  ])("clamps %s persisted values safely", (_label, stored, expected) => {
    localStorage.setItem(HISTORY_WIDTH_STORAGE_KEY, stored);

    const { result } = renderHook(() => useChatHistoryPanelLayout());

    expect(result.current.historyWidth).toBe(expected);
  });

  it("clamps invalid programmatic widths before exposing them", () => {
    const { result } = renderHook(() => useChatHistoryPanelLayout());

    act(() => result.current.resizeHistoryWidth(Number.NaN));
    expect(result.current.historyWidth).toBe(DEFAULT_HISTORY_WIDTH);

    act(() => result.current.resizeHistoryWidth(-1));
    expect(result.current.historyWidth).toBe(MIN_HISTORY_WIDTH);

    act(() => result.current.resizeHistoryWidth(Number.POSITIVE_INFINITY));
    expect(result.current.historyWidth).toBe(DEFAULT_HISTORY_WIDTH);
  });

  it("uses a dedicated key without changing the normal panel width key", () => {
    localStorage.setItem("chat-window-manager-width", "500");

    const { result } = renderHook(() => useChatHistoryPanelLayout());
    act(() => result.current.resizeHistoryWidth(400));

    expect(localStorage.getItem("chat-window-manager-width")).toBe("500");
    expect(localStorage.getItem(HISTORY_WIDTH_STORAGE_KEY)).toBe("400");
  });

  it("limits the sidebar by the number of visible 360px chat panes", () => {
    expect(maxHistoryWidthForLayout(1040, 1)).toBe(MAX_HISTORY_WIDTH);
    expect(maxHistoryWidthForLayout(1040, 2)).toBe(320);
    expect(maxHistoryWidthForLayout(1040, 3)).toBe(MIN_HISTORY_WIDTH);
  });

  it("clamps the effective width when the viewport or split layout shrinks", () => {
    expect(clampHistoryWidthForLayout(400, 700, 1)).toBe(340);
    expect(clampHistoryWidthForLayout(400, 1000, 2)).toBe(280);
    expect(clampHistoryWidthForLayout(200, 1200, 1)).toBe(MIN_HISTORY_WIDTH);
  });
});
