import { describe, expect, it } from "vitest";
import { weightBand } from "./weightBand";

describe("weightBand", () => {
  it("lightens the text as the user zooms in", () => {
    expect(weightBand(0.3)).toBe("far");
    expect(weightBand(0.5)).toBe("mid");
    expect(weightBand(0.8)).toBe("near");
    expect(weightBand(2.4)).toBe("near");
  });
});
