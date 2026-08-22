import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";
import type { LocalChatSessionGroup } from "../../utils/localChatSessionGroups";
import {
  DEFAULT_HISTORY_WIDTH,
  MAX_HISTORY_WIDTH,
} from "../../hooks/useChatHistoryPanelLayout";
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
  width?: number;
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
  width = DEFAULT_HISTORY_WIDTH,
  onQueryChange,
  onSelect = vi.fn(),
  onSelectAgent = vi.fn(),
  onDelete = vi.fn(),
}: ControlledPanelProps) {
  const [query, setQuery] = useState(initialQuery);

  return (
    <LocalChatMiniPanel
      width={width}
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
      width={DEFAULT_HISTORY_WIDTH}
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

function ExpandableDeletingPanel() {
  const [sessions, setSessions] = useState(
    Array.from({ length: 8 }, (_, index) =>
      makeSession(`deletable-${index + 1}`, {
        title: `Deletable ${index + 1}`,
        label: `Deletable ${index + 1}`,
      })
    )
  );

  return (
    <LocalChatMiniPanel
      width={DEFAULT_HISTORY_WIDTH}
      activeSessionId={sessions[0].id}
      activeProviderThreadId={null}
      searchQuery=""
      onSearchQueryChange={vi.fn()}
      hasLocalChatSessions
      deletingSessionId={null}
      deleteError={null}
      projectWarning={null}
      sessionGroups={[makeGroup("current", "Current project", sessions)]}
      spawnOutlineBySessionId={new Map()}
      onSelect={vi.fn()}
      onDelete={(sessionId) => {
        setSessions((current) =>
          current.filter((session) => session.id !== sessionId)
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

  it("keeps the history list and row controls usable at the minimum and wider widths", () => {
    const session = makeSession("wide", {
      label:
        "A session with a title that benefits from the wider history panel",
      title:
        "A session with a title that benefits from the wider history panel",
    });
    const onDelete = vi.fn();

    const { rerender } = render(
      <ControlledPanel
        sessionGroups={[makeGroup("current", "Current project", [session])]}
        onDelete={onDelete}
      />
    );

    const panelElement = () => screen.getByTestId("local-chat-mini-panel");
    const panel = () => within(panelElement());

    expect(panelElement()).toHaveStyle({
      width: `${DEFAULT_HISTORY_WIDTH}px`,
    });
    expect(
      panelElement().querySelector(".hc-mini-history-list")
    ).not.toBeNull();
    expect(
      panel().getByRole("button", {
        name: /Load local chat A session with a title/,
      })
    ).toBeInTheDocument();
    expect(
      panelElement().querySelector(".hc-mini-history-open .label")
    ).toHaveTextContent(
      "A session with a title that benefits from the wider history panel"
    );
    expect(
      panel().getByRole("button", {
        name: "Delete local chat A session with a title that benefits from the wider history panel",
      })
    ).toBeInTheDocument();

    rerender(
      <ControlledPanel
        width={MAX_HISTORY_WIDTH}
        sessionGroups={[makeGroup("current", "Current project", [session])]}
        onDelete={onDelete}
      />
    );

    expect(panelElement()).toHaveStyle({ width: `${MAX_HISTORY_WIDTH}px` });
    expect(
      panelElement().querySelector(".hc-mini-history-list")
    ).not.toBeNull();
    expect(
      panel().getByRole("button", {
        name: "Delete local chat A session with a title that benefits from the wider history panel",
      })
    ).toBeInTheDocument();
    expect(
      panelElement().querySelector(".hc-mini-history-open .label")
    ).toHaveTextContent(
      "A session with a title that benefits from the wider history panel"
    );
  });
});

describe("LocalChatMiniPanel session limits", () => {
  it("caps each project independently and exposes accessible expansion state", async () => {
    const user = userEvent.setup();
    const makeSessions = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) =>
        makeSession(`${prefix}-${index + 1}`, {
          title: `${prefix} ${index + 1}`,
          label: `${prefix} ${index + 1}`,
          updatedAt: `2026-01-${String(count - index).padStart(2, "0")}T00:00:00Z`,
        })
      );
    const currentSessions = makeSessions("Current", 8);
    const otherSessions = makeSessions("Other", 8);
    const shortSessions = makeSessions("Short", 7);

    render(
      <ControlledPanel
        sessionGroups={[
          makeGroup("current", "Current project", currentSessions),
          makeGroup("other", "Other project", otherSessions),
          makeGroup("short", "Short project", shortSessions),
        ]}
      />
    );

    const panel = within(screen.getByTestId("local-chat-mini-panel"));
    const current = within(
      panel.getByRole("region", { name: "Current project chats" })
    );
    const other = within(
      panel.getByRole("region", { name: "Other project chats" })
    );
    const short = within(
      panel.getByRole("region", { name: "Short project chats" })
    );

    expect(
      current.getAllByRole("button", { name: /^Load local chat/ })
    ).toHaveLength(7);
    expect(
      other.getAllByRole("button", { name: /^Load local chat/ })
    ).toHaveLength(7);
    expect(
      short.getAllByRole("button", { name: /^Load local chat/ })
    ).toHaveLength(7);
    expect(
      short.queryByRole("button", { name: /Show all/ })
    ).not.toBeInTheDocument();

    await user.click(
      current.getByRole("button", { name: "Show all (1 more)" })
    );

    expect(
      current.getAllByRole("button", { name: /^Load local chat/ })
    ).toHaveLength(8);
    const showLess = current.getByRole("button", { name: "Show less" });
    expect(showLess).toHaveAttribute("aria-expanded", "true");
    expect(showLess).toHaveFocus();
    expect(
      other.getAllByRole("button", { name: /^Load local chat/ })
    ).toHaveLength(7);
    expect(
      other.getByRole("button", { name: "Show all (1 more)" })
    ).toHaveAttribute("aria-expanded", "false");

    await user.click(showLess);
    expect(
      current.getAllByRole("button", { name: /^Load local chat/ })
    ).toHaveLength(7);
    expect(
      current.getByRole("button", { name: "Show all (1 more)" })
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("collapses the control when deleting the final row beyond the default limit", async () => {
    const user = userEvent.setup();
    render(<ExpandableDeletingPanel />);

    const panel = within(screen.getByTestId("local-chat-mini-panel"));
    const current = within(
      panel.getByRole("region", { name: "Current project chats" })
    );

    await user.click(
      current.getByRole("button", { name: "Show all (1 more)" })
    );
    expect(
      current.getAllByRole("button", { name: /^Load local chat/ })
    ).toHaveLength(8);

    await user.click(
      current.getByRole("button", { name: "Delete local chat Deletable 8" })
    );

    expect(
      current.getAllByRole("button", { name: /^Load local chat/ })
    ).toHaveLength(7);
    expect(
      current.queryByRole("button", { name: "Show less" })
    ).not.toBeInTheDocument();
    expect(
      current.queryByRole("button", { name: /Show all/ })
    ).not.toBeInTheDocument();
  });
});
