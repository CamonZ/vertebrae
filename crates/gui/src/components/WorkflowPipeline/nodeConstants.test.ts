import { describe, it, expect } from "vitest";
import {
  LAYOUT_CONSTANTS,
  calculateWorkflowZoneWidth,
  calculateWorkflowZoneHeight,
} from "./nodeConstants";

describe("nodeConstants", () => {
  describe("LAYOUT_CONSTANTS", () => {
    it("should have required layout constants", () => {
      expect(LAYOUT_CONSTANTS.NODE_SPACING_X).toBe(320);
      expect(LAYOUT_CONSTANTS.STEP_Y_OFFSET).toBe(80);
      expect(LAYOUT_CONSTANTS.WORKFLOW_ZONE_PADDING).toBe(40);
      expect(LAYOUT_CONSTANTS.WORKFLOW_ZONE_HEADER_HEIGHT).toBe(80);
      expect(LAYOUT_CONSTANTS.WORKFLOW_ZONE_GAP).toBe(60);
    });

    it("should not have TASK_ZONE_Y_OFFSET (removed after TaskZoneNode removal)", () => {
      expect(
        (LAYOUT_CONSTANTS as Record<string, number | undefined>)
          .TASK_ZONE_Y_OFFSET
      ).toBeUndefined();
    });
  });

  describe("calculateWorkflowZoneWidth", () => {
    it("should return minimum width for 0 steps", () => {
      expect(calculateWorkflowZoneWidth(0)).toBe(400);
    });

    it("should calculate width for single step", () => {
      // 1 * 320 + 40 * 2 = 400
      const result = calculateWorkflowZoneWidth(1);
      expect(result).toBe(400);
    });

    it("should calculate width for multiple steps", () => {
      // 3 * 320 + 40 * 2 = 960 + 80 = 1040
      const result = calculateWorkflowZoneWidth(3);
      expect(result).toBe(1040);
    });

    it("should scale linearly with step count", () => {
      const width1 = calculateWorkflowZoneWidth(1);
      const width2 = calculateWorkflowZoneWidth(2);
      // Should increase by NODE_SPACING_X (320)
      expect(width2 - width1).toBe(320);
    });
  });

  describe("calculateWorkflowZoneHeight", () => {
    it("should calculate height without task zone", () => {
      // After removal of TaskZoneNodes, height should be:
      // 80 (HEADER) + 80 (STEP_Y_OFFSET) + 130 (step height) + 40 (PADDING)
      // = 330
      const height = calculateWorkflowZoneHeight();
      expect(height).toBe(330);
    });

    it("should be approximately 330px (not ~620px with task zone)", () => {
      const height = calculateWorkflowZoneHeight();
      // Verify it's in the expected range (~330px)
      expect(height).toBeGreaterThanOrEqual(320);
      expect(height).toBeLessThanOrEqual(340);
    });

    it("should accommodate step node of 130px height plus spacing", () => {
      // STEP_Y_OFFSET (80) + step height (130) + margins should fit within the zone
      const height = calculateWorkflowZoneHeight();
      const stepNodeHeightNeeded = LAYOUT_CONSTANTS.STEP_Y_OFFSET + 130;

      // The height should be sufficient for step nodes
      expect(height).toBeGreaterThan(stepNodeHeightNeeded);
    });

    it("should include header, step offset, step height, and padding", () => {
      const height = calculateWorkflowZoneHeight();
      const expectedHeight =
        LAYOUT_CONSTANTS.WORKFLOW_ZONE_HEADER_HEIGHT +
        LAYOUT_CONSTANTS.STEP_Y_OFFSET +
        130 +
        LAYOUT_CONSTANTS.WORKFLOW_ZONE_PADDING;

      expect(height).toBe(expectedHeight);
      expect(height).toBe(330);
    });
  });
});
