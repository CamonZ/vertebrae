import { MIN_SPLIT_PANE_WIDTH } from "./useChatPaneManagement";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_WIDTH,
  HISTORY_WIDTH_STORAGE_KEY,
  MAX_HISTORY_WIDTH,
  MIN_HISTORY_WIDTH,
  clampHistoryWidth,
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

    act(() => first.result.current.resizeHistoryWidth(560));

    expect(localStorage.getItem(HISTORY_WIDTH_STORAGE_KEY)).toBe("560");
    first.unmount();

    const second = renderHook(() => useChatHistoryPanelLayout());
    expect(second.result.current.historyWidth).toBe(560);
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

// Deterministic generated cases keep boundary failures reproducible without a new dependency.
describe("history width invariants", () => {
  const requestedWidths = [
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    -Number.MAX_VALUE,
    -1,
    0,
    0.5,
    ...[MIN_HISTORY_WIDTH, MAX_HISTORY_WIDTH].flatMap((boundary) => [
      boundary - 1,
      boundary - 0.5,
      boundary,
      boundary + 0.5,
      boundary + 1,
    ]),
    ...Array.from({ length: 33 }, (_, index) => index * 47.25),
    Number.MAX_VALUE,
  ];

  it("always returns a finite bounded width and is idempotent", () => {
    for (const requested of requestedWidths) {
      const width = clampHistoryWidth(requested);

      expect(Number.isFinite(width), `requested=${requested}`).toBe(true);
      expect(width).toBeGreaterThanOrEqual(MIN_HISTORY_WIDTH);
      expect(width).toBeLessThanOrEqual(MAX_HISTORY_WIDTH);
      expect(clampHistoryWidth(width)).toBe(width);
    }
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "respects available space with %i panes across generated layouts",
    (paneCount) => {
      const paneSpace = paneCount * MIN_SPLIT_PANE_WIDTH;
      const panelWidths = [
        0,
        paneSpace - 1,
        ...[MIN_HISTORY_WIDTH, MAX_HISTORY_WIDTH].flatMap((boundary) => [
          paneSpace + boundary - 0.5,
          paneSpace + boundary,
          paneSpace + boundary + 0.5,
        ]),
        ...Array.from({ length: 17 }, (_, index) => index * 173.5),
        Number.MAX_VALUE,
      ].sort((left, right) => left - right);
      const finiteRequests = requestedWidths
        .filter(Number.isFinite)
        .sort((left, right) => left - right);

      for (const panelWidth of panelWidths) {
        let previousWidth = MIN_HISTORY_WIDTH;

        for (const requested of finiteRequests) {
          const width = clampHistoryWidthForLayout(
            requested,
            panelWidth,
            paneCount
          );
          const context = `requested=${requested}, panel=${panelWidth}, panes=${paneCount}`;

          expect(Number.isFinite(width), context).toBe(true);
          expect(width, context).toBeGreaterThanOrEqual(MIN_HISTORY_WIDTH);
          expect(width, context).toBeLessThanOrEqual(MAX_HISTORY_WIDTH);
          expect(width, context).toBeLessThanOrEqual(
            clampHistoryWidth(requested)
          );
          expect(width, context).toBeGreaterThanOrEqual(previousWidth);
          expect(
            clampHistoryWidthForLayout(width, panelWidth, paneCount),
            context
          ).toBe(width);

          if (panelWidth >= paneSpace + MIN_HISTORY_WIDTH) {
            expect(panelWidth - width, context).toBeGreaterThanOrEqual(
              paneSpace
            );
          }

          previousWidth = width;
        }
      }

      for (const requested of requestedWidths) {
        const widths = panelWidths.map((panelWidth) =>
          clampHistoryWidthForLayout(requested, panelWidth, paneCount)
        );

        for (let index = 1; index < widths.length; index += 1) {
          expect(widths[index]).toBeGreaterThanOrEqual(widths[index - 1]);
        }
      }
    }
  );

  it("handles malformed layout dimensions without leaking non-finite widths", () => {
    for (const panelWidth of [
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      -1,
    ]) {
      for (const paneCount of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -2,
        0,
        1.5,
      ]) {
        for (const requested of requestedWidths) {
          const width = clampHistoryWidthForLayout(
            requested,
            panelWidth,
            paneCount
          );

          expect(Number.isFinite(width)).toBe(true);
          expect(width).toBeGreaterThanOrEqual(MIN_HISTORY_WIDTH);
          expect(width).toBeLessThanOrEqual(MAX_HISTORY_WIDTH);
        }
      }
    }
  });
});
