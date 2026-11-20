import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  placeCommentCard,
  SELECTION_GAP_PX,
  VIEWPORT_GUTTER_PX,
} from "./commentCardPlacement";

/*
 * Ticket 0de6bdc7: the transcript comment card stays inside the window
 * inset by VIEWPORT_GUTTER_PX, opens below the selection when it fits and
 * above otherwise, and covers the selection only when neither side has room.
 * Selections may be partly or wholly scrolled out of the window.
 */
test("the comment card stays in the inset window and flips above only when below lacks room", () =>
  hegel.test(
    (tc) => {
      const width = tc.draw(gs.integers({ minValue: 120, maxValue: 3000 }));
      const height = tc.draw(gs.integers({ minValue: 80, maxValue: 2000 }));
      const selectionTop = tc.draw(
        gs.integers({ minValue: -600, maxValue: height + 600 })
      );
      const selectionHeight = tc.draw(
        gs.integers({ minValue: 0, maxValue: 600 })
      );
      const selection = {
        top: selectionTop,
        bottom: selectionTop + selectionHeight,
      };
      const edge = {
        left: tc.draw(gs.integers({ minValue: -200, maxValue: width + 200 })),
      };
      const card = {
        width: tc.draw(gs.integers({ minValue: 40, maxValue: 800 })),
        height: tc.draw(gs.integers({ minValue: 20, maxValue: 2500 })),
      };

      const placed = placeCommentCard({
        viewport: { width, height },
        selection,
        edge,
        card,
      });

      const inner = height - 2 * VIEWPORT_GUTTER_PX;
      const shownHeight = Math.min(card.height, inner);
      const shownWidth = Math.min(card.width, width - 2 * VIEWPORT_GUTTER_PX);
      const bottom = placed.top + shownHeight;

      // Containment in the inset window.
      expect(placed.top).toBeGreaterThanOrEqual(VIEWPORT_GUTTER_PX);
      expect(bottom).toBeLessThanOrEqual(height - VIEWPORT_GUTTER_PX);
      expect(placed.left).toBeGreaterThanOrEqual(VIEWPORT_GUTTER_PX);
      expect(placed.left + shownWidth).toBeLessThanOrEqual(
        width - VIEWPORT_GUTTER_PX
      );
      expect(placed.maxHeight).toBe(card.height > inner ? inner : null);

      // Flip rule, from the measured height.
      const roomBelow =
        height - VIEWPORT_GUTTER_PX - (selection.bottom + SELECTION_GAP_PX);
      const roomAbove = selection.top - SELECTION_GAP_PX - VIEWPORT_GUTTER_PX;
      const fitsBelow = roomBelow >= shownHeight;
      const fitsAbove = roomAbove >= shownHeight;
      expect(placed.side).toBe(
        fitsBelow ? "below" : fitsAbove ? "above" : "overlap"
      );
      if (placed.side === "below")
        expect(placed.top).toBeGreaterThan(selection.bottom);
      if (placed.side === "above") expect(bottom).toBeLessThan(selection.top);

      // Covering the selection only when neither side has room.
      const overlaps = placed.top < selection.bottom && bottom > selection.top;
      if (overlaps) expect(fitsBelow || fitsAbove).toBe(false);
    },
    { testCases: 500 }
  ));
