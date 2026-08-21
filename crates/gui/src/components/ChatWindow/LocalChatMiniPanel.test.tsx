import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";
import type { LocalChatSessionGroup } from "../../utils/localChatSessionGroups";
import { LocalChatMiniPanel } from "./LocalChatMiniPanel";
import type { SpawnOutlineItem } from "./sessionListUtils";

function makeSession(
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
    projectPath: "/test/project",
    providerResumeId: null,
    messageCount: 1,
    lifecycle: "idle",
    ...overrides,
  };
}

function makeGroup(
  id: string,
  label: string,
  sessions: LocalChatSessionSummary[]
): LocalChatSessionGroup {
  return {
    id,
    label,
    isCurrentProject: id === "current",
    isFallback: false,
    sessions,
  };
}

interface ControlledPanelProps {
  initialQuery?: string;
  hasLocalChatSessions?: boolean;
  sessionGroups?: LocalChatSessionGroup[];
  spawnOutlineBySessionId?: Map<string, SpawnOutlineItem[]>;
  onQueryChange?: (query: string) => void;
  onSelect?: (sessionId: string) => void;
  onSelectAgent?: (parentSessionId: string, agent: SpawnOutlineItem) => void;
  onDelete?: (sessionId: string) => void;
}

function ControlledPanel({
  initialQuery = "",
  hasLocalChatSessions,
  sessionGroups = [],
  spawnOutlineBySessionId = new Map(),
  onQueryChange,
  onSelect = vi.fn(),
  onSelectAgent = vi.fn(),
  onDelete = vi.fn(),
}: ControlledPanelProps) {
  const [query, setQuery] = useState(initialQuery);

  return (
    <LocalChatMiniPanel
      activeSessionId={sessionGroups[0]?.sessions[0]?.id ?? "active"}
      activeProviderThreadId={null}
      searchQuery={query}
      onSearchQueryChange={(nextQuery) => {
        setQuery(nextQuery);
        onQueryChange?.(nextQuery);
      }}
      hasLocalChatSessions={hasLocalChatSessions ?? sessionGroups.length > 0}
      deletingSessionId={null}
      deleteError={null}
      projectWarning={null}
      sessionGroups={sessionGroups}
      spawnOutlineBySessionId={spawnOutlineBySessionId}
      onSelect={onSelect}
      onSelectAgent={onSelectAgent}
      onDelete={onDelete}
    />
  );
}

function DeletingPanel() {
  const session = makeSession("matching", {
    label: "Matching session",
    title: "Matching session",
  });
  const [query, setQuery] = useState("matching");
  const [sessionGroups, setSessionGroups] = useState([
    makeGroup("current", "Current project", [session]),
  ]);

  return (
    <LocalChatMiniPanel
      activeSessionId={session.id}
      activeProviderThreadId={null}
      searchQuery={query}
      onSearchQueryChange={setQuery}
      hasLocalChatSessions={sessionGroups.length > 0}
      deletingSessionId={null}
      deleteError={null}
      projectWarning={null}
      sessionGroups={sessionGroups}
      spawnOutlineBySessionId={new Map()}
      onSelect={vi.fn()}
      onDelete={(sessionId) => {
        setSessionGroups((groups) =>
          groups
            .map((group) => ({
              ...group,
              sessions: group.sessions.filter(
                (candidate) => candidate.id !== sessionId
              ),
            }))
            .filter((group) => group.sessions.length > 0)
        );
      }}
    />
  );
}

describe("LocalChatMiniPanel search", () => {
  it("renders an accessible controlled search field and updates as it is typed", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    render(
      <ControlledPanel
        sessionGroups={[makeGroup("current", "Current project", [])]}
        onQueryChange={onQueryChange}
      />
    );

    const input = screen.getByRole("searchbox", {
      name: "Search local chats",
    });
    expect(input).toHaveAttribute("id", "local-chat-session-search");
    expect(input).toHaveAttribute("placeholder", "Search chats…");
    expect(input).toHaveAttribute("data-testid", "local-chat-session-search");

    await user.type(input, "Inspect");

    expect(input).toHaveValue("Inspect");
    expect(onQueryChange).toHaveBeenLastCalledWith("Inspect");
  });

  it("clears through the affordance and Escape while retaining input focus", async () => {
    const user = userEvent.setup();
    render(<ControlledPanel initialQuery="older" />);

    const input = screen.getByRole("searchbox", {
      name: "Search local chats",
    });
    const clearButton = screen.getByRole("button", { name: "Clear search" });

    await user.click(clearButton);
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(screen.getByTestId("local-chat-history-empty")).toHaveTextContent(
      "No local chats yet."
    );

    await user.type(input, "missing");
    await user.keyboard("{Escape}");

    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
  });

  it("distinguishes no local chats from a query with no matches", () => {
    const emptyRender = render(<ControlledPanel />);
    expect(screen.getByTestId("local-chat-history-empty")).toHaveTextContent(
      "No local chats yet."
    );
    emptyRender.unmount();

    render(<ControlledPanel initialQuery="missing" hasLocalChatSessions />);
    expect(
      screen.getByTestId("local-chat-history-no-results")
    ).toHaveTextContent("No local chats match “missing”.");
    expect(
      screen.queryByTestId("local-chat-history-empty")
    ).not.toBeInTheDocument();
  });

  it("keeps the no-local-chats state when the underlying history is empty", () => {
    render(
      <ControlledPanel initialQuery="missing" hasLocalChatSessions={false} />
    );

    expect(screen.getByTestId("local-chat-history-empty")).toHaveTextContent(
      "No local chats yet."
    );
    expect(
      screen.queryByTestId("local-chat-history-no-results")
    ).not.toBeInTheDocument();
  });

  it("restores empty-state content after deleting the final matching session", async () => {
    const user = userEvent.setup();
    render(<DeletingPanel />);

    await user.click(
      screen.getByRole("button", {
        name: "Delete local chat Matching session",
      })
    );
    expect(screen.getByTestId("local-chat-history-empty")).toHaveTextContent(
      "No local chats yet."
    );
    expect(
      screen.queryByTestId("local-chat-history-no-results")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByTestId("local-chat-history-empty")).toHaveTextContent(
      "No local chats yet."
    );
  });

  it("keeps matching project headings, nested agents, selection, and deletion usable", async () => {
    const user = userEvent.setup();
    const parent = makeSession("parent", {
      label: "Inspect repository",
      title: "Inspect repository",
    });
    const agent: SpawnOutlineItem = {
      id: "spawn-1",
      spawnId: "tool-1",
      threadId: "agent-thread-1",
      label: "Reviewer",
      detail: "reviewer",
    };
    const onSelect = vi.fn();
    const onSelectAgent = vi.fn();
    const onDelete = vi.fn();

    render(
      <ControlledPanel
        initialQuery="inspect"
        sessionGroups={[
          makeGroup("empty", "Empty project", []),
          makeGroup("current", "Current project", [parent]),
        ]}
        spawnOutlineBySessionId={new Map([[parent.id, [agent]]])}
        onSelect={onSelect}
        onSelectAgent={onSelectAgent}
        onDelete={onDelete}
      />
    );

    const panel = within(screen.getByTestId("local-chat-mini-panel"));
    expect(panel.getAllByRole("heading", { level: 3 })).toHaveLength(1);
    expect(
      panel.getByRole("region", { name: "Current project chats" })
    ).toBeInTheDocument();
    expect(
      panel.queryByRole("region", { name: "Empty project chats" })
    ).not.toBeInTheDocument();

    await user.click(
      panel.getByRole("button", {
        name: "Load local chat Inspect repository into active pane",
      })
    );
    expect(onSelect).toHaveBeenCalledWith(parent.id);

    await user.click(
      panel.getByRole("button", {
        name: "Open spawned agent Reviewer from Inspect repository",
      })
    );
    expect(onSelectAgent).toHaveBeenCalledWith(parent.id, agent);

    const deleteButton = panel.getByRole("button", {
      name: "Delete local chat Inspect repository",
    });
    deleteButton.focus();
    fireEvent.keyDown(deleteButton, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);

    await user.click(deleteButton);
    expect(onDelete).toHaveBeenCalledWith(parent.id);
  });

  it("keeps the search field out of session-row keyboard navigation", () => {
    const session = makeSession("matching", {
      label: "Matching session",
      title: "Matching session",
    });
    const onSelect = vi.fn();
    render(
      <ControlledPanel
        initialQuery="matching"
        sessionGroups={[makeGroup("current", "Current project", [session])]}
        onSelect={onSelect}
      />
    );

    const input = screen.getByRole("searchbox", {
      name: "Search local chats",
    });
    input.focus();
    const arrowDown = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowDown",
    });
    input.dispatchEvent(arrowDown);

    expect(arrowDown.defaultPrevented).toBe(false);
    expect(input).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();

    const panel = screen.getByTestId("local-chat-mini-panel");
    fireEvent.keyDown(panel, { key: "Home" });
    const sessionButton = screen.getByRole("button", {
      name: "Load local chat Matching session into active pane",
    });
    expect(sessionButton).toHaveFocus();

    fireEvent.keyDown(sessionButton, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(session.id);
  });
});
