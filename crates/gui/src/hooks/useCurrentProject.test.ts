import { describe, expect, it } from "vitest";
import { projectAvatarBucket } from "./useCurrentProject";

describe("projectAvatarBucket", () => {
  it("is deterministic for the same input", () => {
    expect(projectAvatarBucket("vertebrae")).toBe(
      projectAvatarBucket("vertebrae"),
    );
  });

  it("returns a value in [0, 7]", () => {
    for (const name of ["a", "blog", "myproject", "🦴", "", "long-project"]) {
      const b = projectAvatarBucket(name);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(7);
    }
  });

  it("returns 0 for null/empty", () => {
    expect(projectAvatarBucket(null)).toBe(0);
    expect(projectAvatarBucket(undefined)).toBe(0);
    expect(projectAvatarBucket("")).toBe(0);
  });

  it("distributes different names across buckets", () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    const buckets = new Set(names.map(projectAvatarBucket));
    // Should hit at least 4 distinct buckets with 8 inputs
    expect(buckets.size).toBeGreaterThanOrEqual(4);
  });
});
