import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionGroupList } from "./SessionGroupList";
import type { LocalChatSessionGroup } from "../../utils/localChatSessionGroups";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";

function makeSummary(
  overrides: Partial<LocalChatSessionSummary> = {}
): LocalChatSessionSummary {
  return {
    id: "s1",
    label: "Chat 1",
    harness: "claude",
    preview: "Hello",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    projectPath: null,
    providerResumeId: null,
    messageCount: 1,
    lifecycle: "idle",
    ...overrides,
  };
}

function makeGroup(
  overrides: Partial<LocalChatSessionGroup> = {}
): LocalChatSessionGroup {
  return {
    id: "g1",
    label: "Test Project",
    isCurrentProject: false,
    isFallback: false,
    sessions: [makeSummary()],
    ...overrides,
  };
}

describe("SessionGroupList", () => {
  it("renders groups with the provided group renderer", () => {
    const groups = [
      makeGroup({ id: "g1", label: "Alpha", sessions: [makeSummary({ id: "s1" })] }),
      makeGroup({ id: "g2", label: "Beta", sessions: [makeSummary({ id: "s2" })] }),
    ];
    render(
      <SessionGroupList
        sessionGroups={groups}
        activeSessionId="s1"
        deletingSessionId={null}
        renderGroup={(group, rows) => (
          <section key={group.id} data-testid={`group-${group.id}`}>
            <h3>{group.label}</h3>
            {rows}
          </section>
        )}
        renderRow={(session) => (
          <div key={session.id} data-testid={`row-${session.id}`}>
            {session.label}
          </div>
        )}
      />
    );

    expect(screen.getByTestId("group-g1")).toBeInTheDocument();
    expect(screen.getByTestId("group-g2")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("passes isActive=true for the session matching activeSessionId", () => {
    const groups = [
      makeGroup({
        sessions: [
          makeSummary({ id: "s1" }),
          makeSummary({ id: "s2", label: "Chat 2" }),
        ],
      }),
    ];
    render(
      <SessionGroupList
        sessionGroups={groups}
        activeSessionId="s2"
        deletingSessionId={null}
        renderGroup={(_group, rows) => <div key="g1">{rows}</div>}
        renderRow={(session, state) => (
          <div
            key={session.id}
            data-testid={`row-${session.id}`}
            data-active={state.isActive || undefined}
          >
            {session.label}
          </div>
        )}
      />
    );

    expect(screen.getByTestId("row-s1")).not.toHaveAttribute("data-active");
    expect(screen.getByTestId("row-s2")).toHaveAttribute("data-active");
  });

  it("passes isDeleting=true for the session matching deletingSessionId", () => {
    const groups = [
      makeGroup({ sessions: [makeSummary({ id: "s1" })] }),
    ];
    render(
      <SessionGroupList
        sessionGroups={groups}
        activeSessionId=""
        deletingSessionId="s1"
        renderGroup={(_group, rows) => <div key="g1">{rows}</div>}
        renderRow={(session, state) => (
          <div
            key={session.id}
            data-testid={`row-${session.id}`}
            data-deleting={state.isDeleting || undefined}
          >
            {session.label}
          </div>
        )}
      />
    );

    expect(screen.getByTestId("row-s1")).toHaveAttribute("data-deleting");
  });

  it("renders an empty list when there are no groups", () => {
    const { container } = render(
      <SessionGroupList
        sessionGroups={[]}
        activeSessionId=""
        deletingSessionId={null}
        renderGroup={(group) => (
          <div key={group.id} data-testid="group" />
        )}
        renderRow={(session) => <div key={session.id} />}
      />
    );
    expect(container.querySelectorAll('[data-testid="group"]')).toHaveLength(0);
  });

  it("keys rows by session id so re-renders are stable", () => {
    const groups = [
      makeGroup({ sessions: [makeSummary({ id: "s1" })] }),
    ];
    const { rerender } = render(
      <SessionGroupList
        sessionGroups={groups}
        activeSessionId=""
        deletingSessionId={null}
        renderGroup={(_g, rows) => <div key="g1">{rows}</div>}
        renderRow={(s) => <div key={s.id} data-testid="row">{s.id}</div>}
      />
    );
    rerender(
      <SessionGroupList
        sessionGroups={groups}
        activeSessionId=""
        deletingSessionId={null}
        renderGroup={(_g, rows) => <div key="g1">{rows}</div>}
        renderRow={(s) => <div key={s.id} data-testid="row">{s.id}</div>}
      />
    );
    expect(screen.getAllByTestId("row")).toHaveLength(1);
  });
});
