import { describe, it, expect } from "vitest";
import { getStatusColor, getStatusIcon, getLevelDotColor } from "./taskUtils";

describe("taskUtils", () => {
  describe("getStatusColor", () => {
    it("returns selected styles when isSelected is true", () => {
      const result = getStatusColor("any_status", true);
      expect(result).toBe("border-primary bg-primary/20 ring-1 ring-primary/50");
    });

    it("returns in_progress styles", () => {
      const result = getStatusColor("in_progress", false);
      expect(result).toBe("border-accent bg-accent/10");
    });

    it("returns completed styles", () => {
      const result = getStatusColor("completed", false);
      expect(result).toBe("border-success/50 bg-success/5");
    });

    it("returns done styles (same as completed)", () => {
      const result = getStatusColor("done", false);
      expect(result).toBe("border-success/50 bg-success/5");
    });

    it("returns failed styles", () => {
      const result = getStatusColor("failed", false);
      expect(result).toBe("border-error bg-error/10");
    });

    it("returns default styles for unknown status", () => {
      const result = getStatusColor("unknown", false);
      expect(result).toBe("border-border bg-bg-tertiary");
    });

    it("returns default styles for pending status", () => {
      const result = getStatusColor("pending", false);
      expect(result).toBe("border-border bg-bg-tertiary");
    });

    it("prioritizes selected over status", () => {
      const result = getStatusColor("failed", true);
      expect(result).toBe("border-primary bg-primary/20 ring-1 ring-primary/50");
    });
  });

  describe("getStatusIcon", () => {
    it("returns spinning icon for in_progress", () => {
      expect(getStatusIcon("in_progress")).toBe("⟳");
    });

    it("returns checkmark for completed", () => {
      expect(getStatusIcon("completed")).toBe("✓");
    });

    it("returns checkmark for done", () => {
      expect(getStatusIcon("done")).toBe("✓");
    });

    it("returns X for failed", () => {
      expect(getStatusIcon("failed")).toBe("✕");
    });

    it("returns circle for unknown status", () => {
      expect(getStatusIcon("unknown")).toBe("○");
    });

    it("returns circle for pending status", () => {
      expect(getStatusIcon("pending")).toBe("○");
    });
  });

  describe("getLevelDotColor", () => {
    it("returns info color for epic", () => {
      expect(getLevelDotColor("epic")).toBe("bg-info");
    });

    it("returns primary color for ticket", () => {
      expect(getLevelDotColor("ticket")).toBe("bg-primary");
    });

    it("returns secondary color for task", () => {
      expect(getLevelDotColor("task")).toBe("bg-text-secondary");
    });

    it("returns muted color for unknown level", () => {
      // Cast to any to test the default case
      expect(getLevelDotColor("unknown" as "epic")).toBe("bg-text-muted");
    });
  });
});
