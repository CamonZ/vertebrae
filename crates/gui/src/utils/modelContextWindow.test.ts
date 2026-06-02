import { describe, it, expect } from "vitest";
import {
  formatTokenCount,
  resolveContextWindow,
  utilizationLevel,
} from "./modelContextWindow";

describe("resolveContextWindow", () => {
  it("returns 1M for opus 4.7 and 4.8 variants", () => {
    expect(resolveContextWindow("claude-opus-4-8", undefined)).toBe(1_000_000);
    expect(resolveContextWindow("opus-4.8", undefined)).toBe(1_000_000);
    expect(resolveContextWindow("claude-opus-4-7-20250115", undefined)).toBe(
      1_000_000
    );
    expect(resolveContextWindow("opus-4.7", undefined)).toBe(1_000_000);
  });

  it("returns 600k for sonnet 4.6", () => {
    expect(resolveContextWindow("claude-sonnet-4-6-latest", undefined)).toBe(
      600_000
    );
  });

  it("returns 200k for haiku 4.5", () => {
    expect(resolveContextWindow("claude-haiku-4-5", undefined)).toBe(200_000);
  });

  it("falls back to backend value when model not in table", () => {
    expect(resolveContextWindow("claude-mystery-9-9", 250_000)).toBe(250_000);
  });

  it("returns undefined when model unknown and no fallback", () => {
    expect(resolveContextWindow("claude-mystery-9-9", undefined)).toBeUndefined();
  });

  it("handles empty model with fallback", () => {
    expect(resolveContextWindow(undefined, 200_000)).toBe(200_000);
  });
});

describe("formatTokenCount", () => {
  it("formats sub-1k counts as raw integers", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("formats thousands as Nk", () => {
    expect(formatTokenCount(1_000)).toBe("1k");
    expect(formatTokenCount(142_300)).toBe("142k");
  });

  it("formats round millions as NM", () => {
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(10_000_000)).toBe("10M");
  });

  it("formats fractional millions with one decimal", () => {
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
    expect(formatTokenCount(2_300_000)).toBe("2.3M");
  });
});

describe("utilizationLevel", () => {
  it("returns ok below 70%", () => {
    expect(utilizationLevel(0, 1_000_000)).toBe("ok");
    expect(utilizationLevel(699_999, 1_000_000)).toBe("ok");
  });

  it("returns warn at 70%-89%", () => {
    expect(utilizationLevel(700_000, 1_000_000)).toBe("warn");
    expect(utilizationLevel(899_999, 1_000_000)).toBe("warn");
  });

  it("returns danger at 90%+", () => {
    expect(utilizationLevel(900_000, 1_000_000)).toBe("danger");
    expect(utilizationLevel(1_000_000, 1_000_000)).toBe("danger");
  });

  it("returns ok when max is non-positive", () => {
    expect(utilizationLevel(100, 0)).toBe("ok");
  });
});
