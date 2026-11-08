import { describe, expect, it } from "vitest";
import { allocatePaneWidths, resizePanePair } from "./chatPaneWidths";
import type { PaneWidths } from "./chatPaneWidths";

describe("pane width geometry", () => {
  it.each([2, 3, 4, 5, 6])(
    "conserves adjacent space for %i panes with fractional geometry",
    (count) => {
      const ids = Array.from({ length: count }, (_, index) => `pane-${index}`);
      const totalPaneWidth = count * 500.25;
      const separatorWidth = (count - 1) * 8;
      const containerWidth = totalPaneWidth + separatorWidth;
      const widths = allocatePaneWidths(ids, containerWidth);

      for (const delta of [-1e6, -70.33, 0, 45.71, 1e6]) {
        for (let index = 1; index < count; index++) {
          const leftId = ids[index - 1];
          const rightId = ids[index];
          const next = resizePanePair(widths, leftId, rightId, delta);

          const originalPairWidth = widths[leftId] + widths[rightId];
          const nextPairWidth = next[leftId] + next[rightId];

          expect(nextPairWidth).toBeCloseTo(originalPairWidth, 8);

          ids.forEach((id, neighborIndex) => {
            expect(next[id]).toBeGreaterThanOrEqual(360);

            const isUnaffectedNeighbor =
              neighborIndex !== index && neighborIndex !== index - 1;

            if (isUnaffectedNeighbor) expect(next[id]).toBe(widths[id]);
          });
        }
      }

      const allocatedWidths = Object.values(widths);
      const allocatedTotal = allocatedWidths.reduce(
        (sum, width) => sum + width,
        0
      );

      expect(allocatedTotal).toBeCloseTo(totalPaneWidth, 8);
    }
  );

  it("keeps ID proportions across container/history changes without erasing them at minimum", () => {
    const preferred = { a: 800, b: 400, stale: 900 };

    const reordered = allocatePaneWidths(["b", "a"], 1208, preferred);
    expect(reordered).toEqual({ b: 400, a: 800 });

    const minimum = allocatePaneWidths(["a", "b"], 728, preferred);
    expect(minimum).toEqual({ a: 360, b: 360 });

    const expanded = allocatePaneWidths(["a", "b"], 1448, preferred);
    expect(expanded).toEqual({ a: 960, b: 480 });

    const surviving = allocatePaneWidths(["a"], 500, preferred);
    expect(surviving).toEqual({ a: 500 });
  });

  it.each([0, -10, NaN, Infinity, 100])(
    "uses minimum overflow for unmeasured/undersized width %s",
    (width) => {
      const invalidPreferences = { a: NaN, b: -50 };
      const sizes = allocatePaneWidths(["a", "b"], width, invalidPreferences);

      expect(sizes).toEqual({ a: 360, b: 360 });

      const resized = resizePanePair(sizes, "a", "b", 1e6);
      expect(resized).toBe(sizes);
    }
  );

  it("rejects stale/invalid pair data and avoids cumulative drift", () => {
    const staleSizes = { a: 500 };
    const staleResult = resizePanePair(staleSizes, "a", "missing", 50);

    expect(staleResult).toEqual(staleSizes);

    let sizes: PaneWidths = { a: 501.75, b: 602.25 };

    for (let index = 0; index < 10000; index++) {
      const delta = index % 2 ? -0.125 : 0.125;

      sizes = resizePanePair(sizes, "a", "b", delta);
    }

    expect(sizes).toEqual({ a: 501.75, b: 602.25 });

    const extremePreferences = {
      a: Number.MAX_VALUE,
      b: Number.MAX_VALUE,
      c: 1,
    };
    const extreme = allocatePaneWidths(
      ["a", "b", "c"],
      2000,
      extremePreferences
    );
    const extremeWidths = Object.values(extreme);
    const extremeTotal = extremeWidths.reduce((sum, width) => sum + width);

    expect(extreme.c).toBe(360);
    expect(extremeTotal).toBeCloseTo(1984, 8);
  });
});
