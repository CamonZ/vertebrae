import { describe, expect, it } from "vitest";
import { replaySpeedTier } from "./localChatSpeedTier";

function event(id: string, status?: unknown) {
  return JSON.stringify({
    version: 1,
    type: "session_started",
    data: {
      provider_resume_id: id,
      speed_tier_status: status,
    },
  });
}

describe("normalized historical speed tiers", () => {
  it("uses the latest root setting, preserves requested intent during fallback, and ignores foreign sessions", () => {
    expect(
      replaySpeedTier(
        [
          event("root", { active: "default" }),
          event("root", { requested: "fast", active: "default" }),
          event("child", { requested: "default" }),
        ],
        "root"
      )
    ).toBe("fast");
  });

  it.each([
    undefined,
    null,
    {},
    { active: "future" },
    { requested: 42 },
    false,
  ])("leaves missing or unsupported historical state unknown: %j", (status) => {
    expect(
      replaySpeedTier(["bad json", event("root", status)], "root")
    ).toBeUndefined();
  });
});
