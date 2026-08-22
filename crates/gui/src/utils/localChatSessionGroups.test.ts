import { describe, expect, it } from "vitest";
import type { SavedProject } from "../bindings";
import type { LocalChatSessionSummary } from "./localChatPersistence";
import {
  FALLBACK_CHAT_PROJECT_LABEL,
  LOCAL_CHAT_SESSION_ROW_LIMIT,
  filterLocalChatSessionGroups,
  groupLocalChatSessionsByProject,
  localChatSessionDisplayTitle,
  normalizeLocalChatSessionQuery,
  projectLocalChatSessionGroups,
} from "./localChatSessionGroups";

const projects: SavedProject[] = [
  { slug: "alpha", project_id: "project-alpha", path: "/work/alpha" },
  { slug: "beta", project_id: "project-beta", path: "/work/beta" },
];

function makeSummary(
  id: string,
  projectPath: string | null,
  updatedAt: string,
  overrides: Partial<LocalChatSessionSummary> = {}
): LocalChatSessionSummary {
  return {
    id,
    label: id,
    harness: "claude",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt,
    projectPath,
    providerResumeId: null,
    messageCount: 1,
    lifecycle: "idle",
    ...overrides,
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
      projectId: "project-alpha",
      projectPath: "/work/alpha",
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

describe("local chat session history search", () => {
  it("normalizes query whitespace and casing safely", () => {
    expect(normalizeLocalChatSessionQuery("  Fix CHAT  ")).toBe("fix chat");
    expect(normalizeLocalChatSessionQuery(" \t ")).toBe("");
    expect(normalizeLocalChatSessionQuery(null)).toBe("");
    expect(normalizeLocalChatSessionQuery(42)).toBe("");
  });

  it("uses the displayed title first and falls back to the label", () => {
    expect(
      localChatSessionDisplayTitle({
        title: "  Inferred title  ",
        label: "Fallback label",
      })
    ).toBe("Inferred title");
    expect(
      localChatSessionDisplayTitle({ title: "  ", label: "  Fallback label " })
    ).toBe("Fallback label");
    expect(
      localChatSessionDisplayTitle({
        title: 42 as never,
        label: null as never,
      })
    ).toBe("New Chat");
  });

  it("returns blank-query groups unchanged", () => {
    const groups = groupLocalChatSessionsByProject(
      [makeSummary("session-1", "/work/alpha", "2026-01-01T00:00:00Z")],
      projects,
      "/work/alpha"
    );

    expect(filterLocalChatSessionGroups(groups, "")).toBe(groups);
    expect(filterLocalChatSessionGroups(groups, "  \t ")).toBe(groups);
  });

  it("matches titles case-insensitively and does not search a hidden fallback label", () => {
    const groups = groupLocalChatSessionsByProject(
      [
        makeSummary("title-match", "/work/alpha", "2026-01-02T00:00:00Z", {
          title: "Fix The CHAT Panel",
          label: "Unrelated fallback",
        }),
        makeSummary("fallback-only", "/work/alpha", "2026-01-01T00:00:00Z", {
          title: "Visible title",
          label: "Hidden fallback",
        }),
      ],
      projects,
      "/work/alpha"
    );

    expect(
      filterLocalChatSessionGroups(groups, "  chat ")[0].sessions.map(
        (session) => session.id
      )
    ).toEqual(["title-match"]);
    expect(filterLocalChatSessionGroups(groups, "fallback")).toEqual([]);
  });

  it("matches the fallback label when the title is absent or whitespace", () => {
    const groups = groupLocalChatSessionsByProject(
      [
        makeSummary("missing-title", "/work/alpha", "2026-01-02T00:00:00Z", {
          label: "Fallback Search Label",
        }),
        makeSummary("blank-title", "/work/alpha", "2026-01-01T00:00:00Z", {
          title: "   ",
          label: "Another Label",
        }),
      ],
      projects,
      "/work/alpha"
    );

    expect(
      filterLocalChatSessionGroups(groups, "label")[0].sessions.map(
        (session) => session.id
      )
    ).toEqual(["missing-title", "blank-title"]);
  });

  it("removes non-matching rows and empty groups while preserving metadata and order", () => {
    const groups = groupLocalChatSessionsByProject(
      [
        makeSummary("beta-match", "/work/beta", "2026-01-05T00:00:00Z", {
          title: "Needle beta",
        }),
        makeSummary(
          "alpha-newer-no-match",
          "/work/alpha",
          "2026-01-04T00:00:00Z",
          {
            title: "Other alpha",
          }
        ),
        makeSummary("alpha-match", "/work/alpha", "2026-01-03T00:00:00Z", {
          title: "Needle alpha",
        }),
        makeSummary("fallback-no-match", null, "2026-01-02T00:00:00Z", {
          title: "Other fallback",
        }),
      ],
      projects,
      "/work/alpha"
    );
    const alpha = groups.find((group) => group.id === "project:alpha");
    expect(alpha).toBeDefined();

    const filtered = filterLocalChatSessionGroups(groups, "needle");

    expect(filtered.map((group) => group.id)).toEqual([
      "project:alpha",
      "project:beta",
    ]);
    expect(filtered[0]).toMatchObject({
      id: "project:alpha",
      label: "alpha",
      isCurrentProject: true,
      isFallback: false,
    });
    expect(filtered[0].sessions.map((session) => session.id)).toEqual([
      "alpha-match",
    ]);
    expect(filtered[1].sessions.map((session) => session.id)).toEqual([
      "beta-match",
    ]);
    expect(filtered[0]).not.toBe(alpha);
    expect(
      groups.find((group) => group.id === "project:alpha")?.sessions
    ).toHaveLength(2);
  });

  it("finds a matching session beyond the first seven rows without applying a display cap", () => {
    const sessions = Array.from({ length: 8 }, (_, index) =>
      makeSummary(
        `session-${index + 1}`,
        "/work/alpha",
        `2026-01-${String(8 - index).padStart(2, "0")}T00:00:00Z`,
        { title: index === 7 ? "Older needle session" : `Recent ${index + 1}` }
      )
    );
    const groups = groupLocalChatSessionsByProject(
      sessions,
      projects,
      "/work/alpha"
    );

    expect(
      filterLocalChatSessionGroups(groups, "needle")[0].sessions.map(
        (session) => session.id
      )
    ).toEqual(["session-8"]);
  });

  it("fails safely for malformed title and label values without retaining an empty group", () => {
    const groups = [
      {
        id: "project:alpha",
        label: "alpha",
        projectId: "project-alpha",
        projectPath: "/work/alpha",
        isCurrentProject: true,
        isFallback: false,
        sessions: [
          makeSummary("malformed", "/work/alpha", "2026-01-01T00:00:00Z", {
            title: 12 as never,
            label: null as never,
          }),
        ],
      },
    ];

    expect(filterLocalChatSessionGroups(groups, "does-not-match")).toEqual([]);
    expect(
      filterLocalChatSessionGroups(groups, "new chat")[0].sessions
    ).toHaveLength(1);
  });
});

describe("local chat session display projection", () => {
  it.each([
    [0, 0],
    [1, 1],
    [LOCAL_CHAT_SESSION_ROW_LIMIT, LOCAL_CHAT_SESSION_ROW_LIMIT],
    [LOCAL_CHAT_SESSION_ROW_LIMIT + 1, LOCAL_CHAT_SESSION_ROW_LIMIT],
  ])(
    "keeps %i source sessions at %i visible rows",
    (sourceCount, visibleCount) => {
      const sessions = Array.from({ length: sourceCount }, (_, index) =>
        makeSummary(
          `session-${index + 1}`,
          "/work/alpha",
          `2026-01-${String(sourceCount - index).padStart(2, "0")}T00:00:00Z`
        )
      );
      const groups = [
        {
          id: "project:alpha",
          label: "alpha",
          projectId: "project-alpha",
          projectPath: "/work/alpha",
          isCurrentProject: true,
          isFallback: false,
          sessions,
        },
      ];

      const projected = projectLocalChatSessionGroups(groups);

      expect(projected).toHaveLength(sourceCount === 0 ? 0 : 1);
      if (sourceCount > 0) {
        expect(projected[0].sessions).toHaveLength(visibleCount);
        expect(projected[0].allSessions).toEqual(sessions);
      }
    }
  );

  it("caps each group independently, preserves metadata, and does not mutate inputs", () => {
    const alphaSessions = Array.from({ length: 8 }, (_, index) =>
      makeSummary(
        `alpha-${index + 1}`,
        "/work/alpha",
        `2026-02-${String(8 - index).padStart(2, "0")}T00:00:00Z`
      )
    );
    const betaSessions = [
      makeSummary("beta-1", "/work/beta", "2026-01-01T00:00:00Z"),
    ];
    const groups = [
      {
        id: "project:alpha",
        label: "alpha",
        projectId: "project-alpha",
        projectPath: "/work/alpha",
        isCurrentProject: true,
        isFallback: false,
        sessions: alphaSessions,
      },
      {
        id: "project:beta",
        label: "beta",
        projectId: "project-beta",
        projectPath: "/work/beta",
        isCurrentProject: false,
        isFallback: false,
        sessions: betaSessions,
      },
    ];

    const projected = projectLocalChatSessionGroups(groups);

    expect(projected.map((group) => group.id)).toEqual([
      "project:alpha",
      "project:beta",
    ]);
    expect(projected[0]).toMatchObject({
      id: "project:alpha",
      label: "alpha",
      isCurrentProject: true,
      isFallback: false,
    });
    expect(projected[0].sessions.map((session) => session.id)).toEqual(
      alphaSessions
        .slice(0, LOCAL_CHAT_SESSION_ROW_LIMIT)
        .map((session) => session.id)
    );
    expect(projected[1].sessions.map((session) => session.id)).toEqual([
      "beta-1",
    ]);
    expect(groups[0].sessions).toBe(alphaSessions);
    expect(groups[0].sessions).toHaveLength(8);
    expect(projected[0].allSessions).not.toBe(alphaSessions);
  });

  it("filters before projecting so an older matching session remains visible", () => {
    const sessions = Array.from({ length: 8 }, (_, index) =>
      makeSummary(
        `session-${index + 1}`,
        "/work/alpha",
        `2026-03-${String(8 - index).padStart(2, "0")}T00:00:00Z`,
        { title: index === 7 ? "Older matching session" : `Recent ${index}` }
      )
    );
    const groups = groupLocalChatSessionsByProject(
      sessions,
      projects,
      "/work/alpha"
    );

    const projected = projectLocalChatSessionGroups(
      filterLocalChatSessionGroups(groups, "matching")
    );

    expect(projected[0].sessions.map((session) => session.id)).toEqual([
      "session-8",
    ]);
  });
});
