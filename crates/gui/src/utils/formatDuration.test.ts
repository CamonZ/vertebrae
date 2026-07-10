import { describe, it, expect, vi, afterEach } from "vitest";
import { formatDuration } from "./formatDuration";

describe("formatDuration", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns empty string when startedAt is undefined", () => {
    expect(formatDuration(undefined, null)).toBe("");
  });

  it("returns seconds for short durations", () => {
    const started = "2025-01-01T12:00:00Z";
    const completed = "2025-01-01T12:00:45Z";
    expect(formatDuration(started, completed)).toBe("45s");
  });

  it("returns 0s for zero duration", () => {
    const time = "2025-01-01T12:00:00Z";
    expect(formatDuration(time, time)).toBe("0s");
  });

  it("returns minutes and seconds", () => {
    const started = "2025-01-01T12:00:00Z";
    const completed = "2025-01-01T12:02:34Z";
    expect(formatDuration(started, completed)).toBe("2m 34s");
  });

  it("returns minutes only when seconds are zero", () => {
    const started = "2025-01-01T12:00:00Z";
    const completed = "2025-01-01T12:05:00Z";
    expect(formatDuration(started, completed)).toBe("5m");
  });

  it("returns hours and minutes for long durations", () => {
    const started = "2025-01-01T12:00:00Z";
    const completed = "2025-01-01T13:12:00Z";
    expect(formatDuration(started, completed)).toBe("1h 12m");
  });

  it("returns hours only when minutes remainder is zero", () => {
    const started = "2025-01-01T12:00:00Z";
    const completed = "2025-01-01T14:00:00Z";
    expect(formatDuration(started, completed)).toBe("2h");
  });

  it("uses current time when completedAt is null", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T12:01:30Z"));
    const started = "2025-01-01T12:00:00Z";
    expect(formatDuration(started, null)).toBe("1m 30s");
  });
});
