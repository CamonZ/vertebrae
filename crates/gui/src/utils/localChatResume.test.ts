import { describe, expect, it } from "vitest";
import type { LocalChatSessionSummary } from "./localChatPersistence";
import {
  findLatestResumableLocalChatSession,
  hasDurableLocalChatSummary,
} from "./localChatPersistence";

function summary(
  id: string,
  overrides: Partial<LocalChatSessionSummary> = {}
): LocalChatSessionSummary {
  return {
    id,
    label: id,
    title: null,
    harness: "claude",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    projectPath: "/repo",
    providerResumeId: null,
    messageCount: 0,
    lifecycle: "idle",
    ...overrides,
  };
}

describe("local chat resume selection", () => {
  it("recognizes durable content from message count or provider resume state", () => {
    expect(hasDurableLocalChatSummary(summary("empty"))).toBe(false);
    expect(
      hasDurableLocalChatSummary(summary("messages", { messageCount: 1 }))
    ).toBe(true);
    expect(
      hasDurableLocalChatSummary(
        summary("resume", { providerResumeId: "codex-thread" })
      )
    ).toBe(true);
  });

  it("selects the newest durable session in the requested project", () => {
    const selected = findLatestResumableLocalChatSession([
      summary("empty", { updatedAt: "2026-01-04T00:00:00Z" }),
      summary("older", {
        messageCount: 1,
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      summary("other-project", {
        messageCount: 1,
        projectPath: "/other",
        updatedAt: "2026-01-05T00:00:00Z",
      }),
      summary("newer", {
        providerResumeId: "claude-thread",
        updatedAt: "2026-01-03T00:00:00Z",
      }),
    ], "/repo");

    expect(selected?.id).toBe("newer");
  });

  it("returns no misleading continue target when history is empty", () => {
    expect(
      findLatestResumableLocalChatSession([
        summary("empty"),
        summary("manual-empty", { label: "Planning chat" }),
      ], "/repo")
    ).toBeNull();
  });
});
