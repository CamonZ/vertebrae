import { describe, expect, it } from "vitest";
import type { SavedProject } from "../bindings";
import type { LocalChatSessionSummary } from "./localChatPersistence";
import {
  FALLBACK_CHAT_PROJECT_LABEL,
  groupLocalChatSessionsByProject,
} from "./localChatSessionGroups";

const projects: SavedProject[] = [
  { slug: "alpha", project_id: "project-alpha", path: "/work/alpha" },
  { slug: "beta", project_id: "project-beta", path: "/work/beta" },
];

function makeSummary(
  id: string,
  projectPath: string | null,
  updatedAt: string
): LocalChatSessionSummary {
  return {
    id,
    label: id,
    harness: "claude",
    preview: `${id} preview`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt,
    projectPath,
    providerResumeId: null,
    messageCount: 1,
    lifecycle: "idle",
  };
}

describe("local chat session project grouping", () => {
  it("orders the current project first, sorts sessions by recency within groups, and keeps fallback last", () => {
    const groups = groupLocalChatSessionsByProject(
      [
        makeSummary("fallback-missing", null, "2026-01-06T00:00:00Z"),
        makeSummary("beta-newest", "/work/beta", "2026-01-05T00:00:00Z"),
        makeSummary("alpha-old", "/work/alpha", "2026-01-02T00:00:00Z"),
        makeSummary(
          "fallback-unknown",
          "/work/unknown",
          "2026-01-07T00:00:00Z"
        ),
        makeSummary("alpha-new", "/work/alpha", "2026-01-04T00:00:00Z"),
      ],
      projects,
      "/work/alpha"
    );

    expect(groups.map((group) => group.label)).toEqual([
      "alpha",
      "beta",
      FALLBACK_CHAT_PROJECT_LABEL,
    ]);
    expect(groups[0]).toMatchObject({
      id: "project:alpha",
      isCurrentProject: true,
      isFallback: false,
    });
    expect(groups[0].sessions.map((session) => session.id)).toEqual([
      "alpha-new",
      "alpha-old",
    ]);
    expect(groups[2].sessions.map((session) => session.id)).toEqual([
      "fallback-unknown",
      "fallback-missing",
    ]);
  });
});
