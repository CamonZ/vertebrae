import { describe, it, expect } from "vitest";
import {
  harnessDisplayName,
  lifecycleLabel,
  isSessionHarnessLocked,
  isHarnessSelectable,
} from "./chatHelpers";
import type { LocalChatHarnessInfo } from "../../bindings";

describe("harnessDisplayName", () => {
  it("returns 'Claude' for the claude harness", () => {
    expect(harnessDisplayName("claude")).toBe("Claude");
  });

  it("returns 'Codex' for the codex harness", () => {
    expect(harnessDisplayName("codex")).toBe("Codex");
  });
});

describe("lifecycleLabel", () => {
  it.each([
    ["starting", "Starting"],
    ["resuming", "Resuming"],
    ["sending", "Sending"],
    ["streaming", "Streaming"],
    ["closing", "Closing"],
    ["closed", "Closed"],
    ["error", "Failed"],
    ["idle", "Ready"],
  ] as const)("returns '%s' for the %s lifecycle", (lifecycle, expected) => {
    expect(lifecycleLabel(lifecycle)).toBe(expected);
  });
});

describe("isSessionHarnessLocked", () => {
  it("returns false when neither backendSessionId nor providerResumeId is set", () => {
    expect(
      isSessionHarnessLocked({ backendSessionId: null, providerResumeId: null })
    ).toBe(false);
  });

  it("returns true when backendSessionId is set", () => {
    expect(
      isSessionHarnessLocked({
        backendSessionId: "backend-1",
        providerResumeId: null,
      })
    ).toBe(true);
  });

  it("returns true when providerResumeId is set", () => {
    expect(
      isSessionHarnessLocked({
        backendSessionId: null,
        providerResumeId: "resume-1",
      })
    ).toBe(true);
  });

  it("returns true when both are set", () => {
    expect(
      isSessionHarnessLocked({
        backendSessionId: "backend-1",
        providerResumeId: "resume-1",
      })
    ).toBe(true);
  });
});

describe("isHarnessSelectable", () => {
  const claudeInfo: LocalChatHarnessInfo = {
    harness: "claude",
    label: "Claude",
    available: true,
    unavailable_reason: null,
    default_model_id: "sonnet",
    default_reasoning_effort: null,
    reasoning_efforts: [],
    supports_resume: true,
    models: [],
  };
  const codexInfo: LocalChatHarnessInfo = {
    harness: "codex",
    label: "Codex",
    available: false,
    unavailable_reason: "Not installed",
    default_model_id: null,
    default_reasoning_effort: null,
    reasoning_efforts: [],
    supports_resume: true,
    models: [],
  };

  it("returns true when not locked and harness is available", () => {
    expect(isHarnessSelectable(claudeInfo, "claude", false)).toBe(true);
  });

  it("returns false when not locked and harness is unavailable", () => {
    expect(isHarnessSelectable(codexInfo, "codex", false)).toBe(false);
  });

  it("returns true when locked and harness matches the current harness", () => {
    expect(isHarnessSelectable(claudeInfo, "claude", true)).toBe(true);
  });

  it("returns false when locked and harness does not match the current harness", () => {
    expect(isHarnessSelectable(codexInfo, "claude", true)).toBe(false);
  });

  it("returns true when locked, harness matches, even if unavailable", () => {
    expect(isHarnessSelectable(codexInfo, "codex", true)).toBe(true);
  });

  it("returns true when not locked even if harness does not match current", () => {
    expect(isHarnessSelectable(claudeInfo, "codex", false)).toBe(true);
  });
});
