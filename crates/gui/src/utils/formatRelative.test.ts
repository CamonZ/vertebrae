import { describe, it, expect } from "vitest";
import { formatRelative } from "./formatRelative";

describe("formatRelative", () => {
  const now = new Date("2026-05-14T12:00:00Z");

  it("returns empty string for null/undefined/invalid", () => {
    expect(formatRelative(null, now)).toBe("");
    expect(formatRelative(undefined, now)).toBe("");
    expect(formatRelative("not-a-date", now)).toBe("");
  });

  it("returns 'Just now' for events less than a minute ago", () => {
    expect(formatRelative("2026-05-14T11:59:30Z", now)).toBe("Just now");
  });

  it("returns 'Xm ago' for events under an hour", () => {
    expect(formatRelative("2026-05-14T11:45:00Z", now)).toBe("15m ago");
    expect(formatRelative("2026-05-14T11:01:00Z", now)).toBe("59m ago");
  });

  it("returns 'Xh ago' for same-day events older than an hour", () => {
    expect(formatRelative("2026-05-14T09:00:00Z", now)).toBe("3h ago");
  });

  it("returns 'Yesterday' for the previous local day", () => {
    expect(formatRelative("2026-05-13T20:00:00Z", now)).toBe("Yesterday");
  });

  it("returns 'MMM D' for older same-year dates", () => {
    expect(formatRelative("2026-03-04T10:00:00Z", now)).toBe("Mar 4");
  });

  it("returns 'MMM D, YYYY' for prior years", () => {
    expect(formatRelative("2024-12-31T10:00:00Z", now)).toBe("Dec 31, 2024");
  });
});
