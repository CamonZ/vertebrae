import { useState } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";
import {
  selectedLocalChatProject,
  type LocalChatSessionGroup,
} from "../../utils/localChatSessionGroups";
import {
  DEFAULT_HISTORY_WIDTH,
  MAX_HISTORY_WIDTH,
} from "../../hooks/useChatHistoryPanelLayout";
import { LocalChatMiniPanel } from "./LocalChatMiniPanel";
import type { LocalChatSessionActivity } from "./LocalChatMiniPanel";
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
  sessions: LocalChatSessionSummary[],
  overrides: Partial<LocalChatSessionGroup> = {}
): LocalChatSessionGroup {
  return {
    id,
    label,
    projectId: id === "fallback" ? null : `project-${id}`,
    projectPath: id === "fallback" ? null : `/test/${id}`,
    isCurrentProject: id === "current",
    isFallback: false,
    sessions,
    ...overrides,
  };
}

interface ControlledPanelProps {
  initialQuery?: string;
  revealSession?: { sessionId: string; revision: number };
  sessionGroups?: LocalChatSessionGroup[];
  activeSessionId?: string;
  activeProviderThreadId?: string | null;
  spawnOutlineBySessionId?: Map<string, SpawnOutlineItem[]>;
  activityBySessionId?: ReadonlyMap<string, LocalChatSessionActivity>;
  thinkingIndicatorStyle?: "classic" | "futuristic";
  width?: number;
  onQueryChange?: (query: string) => void;
  onSelect?: (sessionId: string) => void;
  onSelectAgent?: (parentSessionId: string, agent: SpawnOutlineItem) => void;
  onStartProjectChat?: (group: LocalChatSessionGroup) => void | Promise<void>;
  onDelete?: (sessionId: string) => void;
}

function ControlledPanel({
  initialQuery = "",
  revealSession,
  sessionGroups = [],
  activeSessionId,
  activeProviderThreadId = null,
  spawnOutlineBySessionId = new Map(),
  activityBySessionId = new Map(),
  thinkingIndicatorStyle = "classic",
  width = DEFAULT_HISTORY_WIDTH,
  onQueryChange,
  onSelect = vi.fn(),
  onSelectAgent = vi.fn(),
  onStartProjectChat,
  onDelete = vi.fn(),
}: ControlledPanelProps) {
  const [query, setQuery] = useState(initialQuery);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedLocalChatProject(
    sessionGroups,
    selectedId,
    activeSessionId ?? sessionGroups[0]?.sessions[0]?.id ?? null
  );

  return (
    <LocalChatMiniPanel
      width={width}
      activeSessionId={
        activeSessionId ?? sessionGroups[0]?.sessions[0]?.id ?? "active"
      }
      activeProviderThreadId={activeProviderThreadId}
      searchQuery={query}
      onSearchQueryChange={(nextQuery) => {
        setQuery(nextQuery);
        onQueryChange?.(nextQuery);
      }}
      selectedProjectId={selected?.id ?? null}
      onSelectProject={setSelectedId}
      revealSession={revealSession}
      deleteError={null}
      projectWarning={null}
      sessionGroups={sessionGroups}
      spawnOutlineBySessionId={spawnOutlineBySessionId}
      activityBySessionId={activityBySessionId}
      thinkingIndicatorStyle={thinkingIndicatorStyle}
      onSelect={onSelect}
      onSelectAgent={onSelectAgent}
      onStartProjectChat={onStartProjectChat}
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
      selectedProjectId="current"
      onSelectProject={vi.fn()}
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

describe("Projects disclosure", () => {
  it("preserves selection, hides project controls from navigation, and toggles by pointer and keyboard", async () => {
    const user = userEvent.setup();
    render(
      <ControlledPanel
        sessionGroups={[
          makeGroup("alpha", "Alpha", [makeSession("alpha-chat")]),
          makeGroup("beta", "Beta", [makeSession("beta-chat")]),
        ]}
      />
    );
    await user.click(screen.getByRole("button", { name: "Beta" }));
    const toggle = screen.getByRole("button", {
      name: "Projects",
    });
    const list = screen.getByTestId("local-chat-project-scroll-region");
    expect(toggle).toHaveAttribute("aria-controls", list.id);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Beta");
    expect(toggle).toHaveAccessibleDescription("Beta");
    expect(list).not.toBeVisible();
    expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
    await user.tab();
    expect(
      screen.getByRole("searchbox", { name: "Search local chats" })
    ).toHaveFocus();
    await user.type(screen.getByRole("searchbox"), "beta");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Beta" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

describe("LocalChatMiniPanel search", () => {
  it("renders one project-scoped plus action per group and dispatches group metadata", async () => {
    const user = userEvent.setup();
    const onStartProjectChat = vi.fn();
    const alpha = makeGroup("alpha", "Alpha", [
      makeSession("alpha-session", { projectPath: "/test/alpha" }),
    ]);
    const beta = makeGroup("beta", "Beta", [
      makeSession("beta-session", { projectPath: "/test/beta" }),
    ]);
    const fallback = makeGroup("fallback", "Unknown project", [
      makeSession("fallback-session", { projectPath: null }),
    ]);

    render(
      <ControlledPanel
        sessionGroups={[alpha, beta, fallback]}
        onStartProjectChat={onStartProjectChat}
      />
    );

    const panel = within(screen.getByTestId("local-chat-mini-panel"));
    const alphaButton = panel.getByRole("button", {
      name: "Start new chat in Alpha",
    });
    const betaButton = panel.getByRole("button", {
      name: "Start new chat in Beta",
    });
    const fallbackButton = panel.getByRole("button", {
      name: "Start new chat in Unknown project",
    });

    expect(panel.getAllByTestId(/^new-project-chat-/)).toHaveLength(3);
    expect(alphaButton).toHaveAttribute("title", "Start a new chat in Alpha");
    expect(fallbackButton).toBeDisabled();
    expect(fallbackButton).toHaveAttribute(
      "title",
      "Cannot start a chat in Unknown project: project directory unavailable"
    );

    await user.click(fallbackButton);
    expect(onStartProjectChat).not.toHaveBeenCalled();

    await user.click(alphaButton);
    expect(onStartProjectChat).toHaveBeenCalledTimes(1);
    expect(onStartProjectChat.mock.calls[0][0]).toMatchObject({
      id: alpha.id,
      projectId: alpha.projectId,
      projectPath: alpha.projectPath,
    });

    betaButton.focus();
    await user.keyboard("{Enter}");
    expect(onStartProjectChat).toHaveBeenCalledTimes(2);
    expect(onStartProjectChat.mock.calls[1][0]).toMatchObject({
      id: beta.id,
      projectId: beta.projectId,
      projectPath: beta.projectPath,
    });
  });

  it("keeps the history chrome outside the bounded scroll region", () => {
    const sessions = Array.from({ length: 24 }, (_, index) =>
      makeSession(`overflow-${index + 1}`, {
        label: `Overflow session ${index + 1}`,
        title: `Overflow session ${index + 1}`,
      })
    );

    render(
      <div className="hc-panel">
        <ControlledPanel
          sessionGroups={[makeGroup("current", "Current project", sessions)]}
        />
      </div>
    );

    const panel = screen.getByTestId("local-chat-mini-panel");
    const header = panel.querySelector<HTMLDivElement>(
      ".hc-mini-history-sessions .hc-mini-history-head"
    );
    const body = screen.getByTestId("local-chat-history-drawer");
    const scrollRegion = screen.getByTestId("local-chat-history-scroll-region");

    expect(panel.firstElementChild).toHaveClass("hc-mini-history-projects");
    expect(panel.querySelector(".hc-mini-history-sessions")).toContainElement(
      header
    );
    expect(body).toHaveClass("hc-mini-history-body");
    expect(body).toContainElement(scrollRegion);
    expect(scrollRegion).toHaveClass("hc-mini-history-list");
    expect(scrollRegion).not.toContainElement(header);
    expect(
      within(scrollRegion).getAllByRole("button", {
        name: /^Load local chat Overflow session/,
      })
    ).toHaveLength(24);
    expect(
      within(panel).getByRole("button", { name: "Current project" })
    ).toBeInTheDocument();
  });

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

    render(
      <ControlledPanel
        initialQuery="missing"
        sessionGroups={[
          makeGroup("current", "Current project", [makeSession("existing")]),
        ]}
      />
    );

    expect(
      screen.getByTestId("local-chat-history-no-results")
    ).toHaveTextContent("No local chats match “missing”.");
    expect(
      screen.queryByTestId("local-chat-history-empty")
    ).not.toBeInTheDocument();
  });

  it("keeps the no-local-chats state when the underlying history is empty", () => {
    render(<ControlledPanel initialQuery="missing" />);

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

    expect(
      panel.getByRole("heading", { name: "Other chats" })
    ).toBeInTheDocument();
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
      panel.getByRole("button", { name: "Subagents for Inspect repository" })
    );

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
    fireEvent.keyDown(deleteButton, { key: " " });
    expect(onSelect).toHaveBeenCalledTimes(1);

    await user.click(deleteButton);
    expect(onDelete).toHaveBeenCalledWith(parent.id);
  });

  it("uses arrow keys from search to select filtered conversations", () => {
    const session = makeSession("matching", {
      label: "Matching session",
      title: "Matching session",
    });
    const nextSession = makeSession("next", {
      label: "Next session",
      title: "Next session",
    });
    const onSelect = vi.fn();
    function SearchNavigationPanel() {
      const [activeSessionId, setActiveSessionId] = useState(session.id);
      return (
        <ControlledPanel
          initialQuery="session"
          activeSessionId={activeSessionId}
          sessionGroups={[
            makeGroup("current", "Current project", [session, nextSession]),
          ]}
          onSelect={(sessionId) => {
            onSelect(sessionId);
            setActiveSessionId(sessionId);
          }}
        />
      );
    }
    render(<SearchNavigationPanel />);

    const input = screen.getByRole("searchbox", {
      name: "Search local chats",
    });
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith(nextSession.id);
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onSelect).toHaveBeenLastCalledWith(session.id);
    expect(
      screen
        .getByRole("button", {
          name: "Load local chat Matching session into active pane",
        })
        .closest(".hc-mini-history-row")
    ).toHaveAttribute("data-active");
  });

  it("does not use an accent keyboard outline for the history selection", () => {
    const session = makeSession("matching", {
      label: "Matching session",
      title: "Matching session",
    });
    render(
      <ControlledPanel
        sessionGroups={[makeGroup("current", "Current project", [session])]}
      />
    );

    expect(
      screen
        .getByRole("button", {
          name: "Load local chat Matching session into active pane",
        })
        .closest(".hc-mini-history-row")
    ).not.toHaveAttribute("data-keyboard-active");
  });

  it("keeps keyboard focus moving through long-list boundaries and selects the focused row", () => {
    const sessions = [
      makeSession("top", { title: "Top session", label: "Top session" }),
      makeSession("middle", {
        title: "Middle session",
        label: "Middle session",
      }),
      makeSession("bottom", {
        title: "Bottom session",
        label: "Bottom session",
      }),
    ];
    const onSelect = vi.fn();
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView"
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      render(
        <ControlledPanel
          sessionGroups={[makeGroup("current", "Current project", sessions)]}
          onSelect={onSelect}
        />
      );

      scrollIntoView.mockClear();

      const panel = screen.getByTestId("local-chat-mini-panel");
      const buttons = screen.getAllByRole("button", {
        name: /^Load local chat/,
      });

      fireEvent.keyDown(panel, { key: "Home" });
      expect(buttons[0]).toHaveFocus();

      fireEvent.keyDown(buttons[0], { key: "ArrowDown" });
      expect(buttons[1]).toHaveFocus();

      fireEvent.keyDown(buttons[1], { key: "End" });
      expect(buttons[2]).toHaveFocus();

      fireEvent.keyDown(buttons[2], { key: " " });
      expect(onSelect).toHaveBeenCalledWith("bottom");
      expect(scrollIntoView).toHaveBeenNthCalledWith(1, {
        block: "nearest",
        inline: "nearest",
      });
      expect(scrollIntoView).toHaveBeenNthCalledWith(2, {
        block: "nearest",
        inline: "nearest",
      });
      expect(scrollIntoView).toHaveBeenNthCalledWith(3, {
        block: "nearest",
        inline: "nearest",
      });
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalScrollIntoView
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
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

  it("shows working child sessions with the existing indicator and opens the selected child", () => {
    const parent = makeSession("root", { title: "Parent", harness: "codex" });
    const worker: SpawnOutlineItem = {
      id: "child",
      threadId: "child-thread",
      spawnId: "spawn",
      label: "Worker",
      detail: "",
      isWorking: true,
    };
    const onSelectAgent = vi.fn();
    const props = {
      sessionGroups: [makeGroup("current", "Current project", [parent])],
      onSelectAgent,
    };
    const { rerender } = render(
      <ControlledPanel
        {...props}
        spawnOutlineBySessionId={new Map([[parent.id, [worker]]])}
        thinkingIndicatorStyle="futuristic"
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Subagents for Parent" })
    );

    const row = screen.getByRole("button", {
      name: "Open spawned agent Worker from Parent",
    });
    expect(within(row).getByTestId("thinking-indicator")).toHaveAttribute(
      "data-style",
      "futuristic"
    );
    fireEvent.click(row);
    expect(onSelectAgent).toHaveBeenCalledWith(parent.id, worker);
    rerender(
      <ControlledPanel
        {...props}
        spawnOutlineBySessionId={
          new Map([[parent.id, [{ ...worker, isWorking: false }]]])
        }
      />
    );
    expect(
      within(
        screen.getByRole("button", {
          name: "Open spawned agent Worker from Parent",
        })
      ).queryByTestId("thinking-indicator")
    ).not.toBeInTheDocument();
  });

  it("shows independent configured activity indicators and restores harness badges", () => {
    const thinking = makeSession("thinking", {
      title: "Thinking session",
      harness: "claude",
    });
    const compacting = makeSession("compacting", {
      title: "Compacting session",
      harness: "codex",
    });
    const idle = makeSession("idle", {
      title: "Idle session",
      harness: "claude",
    });
    const sessions = [thinking, compacting, idle];
    const activityBySessionId = new Map<string, LocalChatSessionActivity>([
      [thinking.id, "thinking"],
      [compacting.id, "compacting"],
    ]);
    const { rerender } = render(
      <ControlledPanel
        sessionGroups={[makeGroup("current", "Current project", sessions)]}
        activityBySessionId={activityBySessionId}
        thinkingIndicatorStyle="futuristic"
      />
    );

    const panel = within(screen.getByTestId("local-chat-mini-panel"));
    const thinkingButton = panel.getByRole("button", {
      name: "Load local chat Thinking session into active pane",
    });
    expect(thinkingButton.querySelector(".hc-mini-history-harness")).toBeNull();
    const thinkingRow = thinkingButton.closest(
      ".hc-mini-history-row"
    ) as HTMLElement;
    const compactingRow = panel
      .getByRole("button", {
        name: "Load local chat Compacting session into active pane",
      })
      .closest(".hc-mini-history-row") as HTMLElement;
    const idleRow = panel
      .getByRole("button", {
        name: "Load local chat Idle session into active pane",
      })
      .closest(".hc-mini-history-row") as HTMLElement;

    expect(
      within(thinkingRow).getByTestId("thinking-indicator")
    ).toHaveAttribute("data-style", "futuristic");
    expect(within(thinkingRow).getByTestId("thinking-matrix")).toHaveAttribute(
      "data-animation-direction",
      "outward"
    );
    expect(
      within(compactingRow).getByTestId("thinking-matrix")
    ).toHaveAttribute("data-animation-direction", "inward");
    expect(within(idleRow).getByRole("img")).toHaveAccessibleName(
      "Claude harness"
    );
    expect(within(thinkingRow).queryByRole("img")).not.toBeInTheDocument();
    expect(within(compactingRow).queryByRole("img")).not.toBeInTheDocument();

    rerender(
      <ControlledPanel
        sessionGroups={[makeGroup("current", "Current project", sessions)]}
        thinkingIndicatorStyle="futuristic"
      />
    );

    const restoredThinkingRow = within(
      screen.getByTestId("local-chat-mini-panel")
    )
      .getByRole("button", {
        name: "Load local chat Thinking session into active pane",
      })
      .closest(".hc-mini-history-row") as HTMLElement;
    expect(
      within(restoredThinkingRow).queryByTestId("thinking-indicator")
    ).not.toBeInTheDocument();
    expect(within(restoredThinkingRow).getByRole("img")).toHaveAccessibleName(
      "Claude harness"
    );
  });
});

describe("LocalChatMiniPanel project and ticket browsing", () => {
  const association = (ticketId: string, ticketTitle = "Shared title") => ({
    ticketId,
    ticketTitle,
    worktreePath: null,
    branch: null,
    lastProcessedAt: null,
    processedAtCount: 0,
    awaitingWorktree: null,
    recentWorktrees: [],
  });

  it("keeps ticket headings compact while retaining full context and nested chats", () => {
    const ticketId = "32fcee8a-20cd-4301-9d8a-748ab49e95d9";
    const ticketTitle =
      "A very long ticket title that should not compete with conversation titles";

    render(
      <ControlledPanel
        sessionGroups={[
          makeGroup("current", "Current project", [
            makeSession("grouped-one", {
              association: association(ticketId, ticketTitle),
            }),
            makeSession("grouped-two", {
              association: association(ticketId, ticketTitle),
            }),
            makeSession("standalone"),
          ]),
        ]}
      />
    );

    const heading = screen.getByRole("button", { name: ticketTitle });

    expect(within(heading).getByText("32fcee8a")).toBeInTheDocument();
    expect(within(heading).getByText("2")).toBeInTheDocument();
    expect(heading).toHaveAttribute("title", `${ticketTitle} · ${ticketId}`);

    expect(heading).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(heading);

    const nestedRows = document.getElementById(
      heading.getAttribute("aria-controls")!
    )!;

    expect(nestedRows).toHaveClass("hc-mini-history-ticket-rows");
    expect(
      within(nestedRows).getAllByRole("button", { name: /^Load local chat/ })
    ).toHaveLength(2);
    expect(nestedRows).not.toContainElement(
      screen.getByRole("button", { name: /Load local chat standalone/ })
    );
  });

  it("starts newly loaded ticket groups collapsed and keeps Other chats visible", () => {
    const { rerender } = render(<ControlledPanel sessionGroups={[]} />);

    rerender(
      <ControlledPanel
        sessionGroups={[
          makeGroup("current", "Project", [
            makeSession("grouped", {
              association: association("ticket-a", "Loaded ticket"),
            }),
            makeSession("standalone"),
          ]),
        ]}
      />
    );

    expect(
      screen.getByRole("button", { name: "Loaded ticket" })
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: /Load local chat grouped/ })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Load local chat standalone/ })
    ).toBeInTheDocument();
  });

  it("browses one project at a time without selecting a chat, including empty projects", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ControlledPanel
        onSelect={onSelect}
        sessionGroups={[
          makeGroup("alpha", "Alpha", [makeSession("alpha-chat")]),
          makeGroup("beta", "Beta", [makeSession("beta-chat")]),
          makeGroup("empty", "Empty", []),
        ]}
      />
    );

    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(
      screen.queryByRole("button", { name: /Load local chat beta-chat/ })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Beta" }));

    expect(
      screen.getByRole("button", { name: /Load local chat beta-chat/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Load local chat alpha-chat/ })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Empty" }));

    expect(screen.getByTestId("local-chat-history-empty")).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("groups stable ticket IDs, toggles by keyboard, and searches older collapsed rows", async () => {
    const user = userEvent.setup();
    const sessions = Array.from({ length: 9 }, (_, index) =>
      makeSession(`chat-${index}`, {
        title: index === 8 ? "Older needle" : `Chat ${index}`,
        association: association("ticket-a"),
      })
    );

    render(
      <ControlledPanel
        sessionGroups={[
          makeGroup("alpha", "Alpha", [
            ...sessions,
            makeSession("distinct", { association: association("ticket-b") }),
            makeSession("standalone"),
          ]),
        ]}
      />
    );

    const headings = screen.getAllByRole("button", { name: "Shared title" });

    expect(headings).toHaveLength(2);

    expect(headings[0]).toHaveAttribute("aria-expanded", "false");
    expect(
      document.getElementById(headings[0].getAttribute("aria-controls")!)
    ).toHaveAttribute("hidden");
    expect(
      screen.queryByRole("button", { name: /Load local chat Older needle/ })
    ).not.toBeInTheDocument();
    headings[0].focus();
    await user.keyboard("{Enter}");

    expect(headings[0]).toHaveAttribute("aria-expanded", "true");

    await user.keyboard(" ");

    expect(headings[0]).toHaveAttribute("aria-expanded", "false");

    await user.type(screen.getByRole("searchbox"), "needle");

    expect(
      screen.getByRole("button", { name: /Load local chat Older needle/ })
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Shared title" })
    ).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(headings[0]).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: /Load local chat standalone/ })
    ).toBeInTheDocument();
  });

  it("reveals a shortcut target in a collapsed ticket and regroups corrected associations", async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView"
    );
    const scrollIntoView = vi.fn();

    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const user = userEvent.setup();
      const session = makeSession("target", {
        association: association("ticket-a", "Original"),
      });
      const group = makeGroup("alpha", "Alpha", [session]);
      const { rerender } = render(<ControlledPanel sessionGroups={[group]} />);

      expect(
        screen.queryByRole("button", { name: /Load local chat target/ })
      ).not.toBeInTheDocument();

      rerender(
        <ControlledPanel
          sessionGroups={[group]}
          revealSession={{ sessionId: "target", revision: 1 }}
        />
      );

      expect(
        await screen.findByRole("button", { name: /Load local chat target/ })
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Original" })).toHaveAttribute(
        "aria-expanded",
        "true"
      );

      const target = screen.getByRole("button", {
        name: /Load local chat target/,
      });

      await waitFor(() => {
        const callIndex = scrollIntoView.mock.contexts.indexOf(target);

        expect(callIndex).toBeGreaterThanOrEqual(0);
        expect(scrollIntoView.mock.calls[callIndex]).toEqual([
          { block: "nearest", inline: "nearest" },
        ]);
      });
      // A handled shortcut must not force this accordion to stay open afterward.
      await user.click(screen.getByRole("button", { name: "Original" }));

      expect(screen.getByRole("button", { name: "Original" })).toHaveAttribute(
        "aria-expanded",
        "false"
      );

      rerender(
        <ControlledPanel
          sessionGroups={[
            {
              ...group,
              sessions: [
                {
                  ...session,
                  association: association("ticket-b", "Corrected"),
                },
              ],
            },
          ]}
        />
      );

      expect(
        screen.queryByRole("button", { name: "Original" })
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Corrected" })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Load local chat target/ })
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Corrected" })).toHaveAttribute(
        "aria-expanded",
        "false"
      );

      rerender(
        <ControlledPanel sessionGroups={[{ ...group, sessions: [] }]} />
      );

      expect(
        screen.queryByRole("button", { name: "Corrected" })
      ).not.toBeInTheDocument();
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalScrollIntoView
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });
});

it("keeps association keyboard actions separate from conversation selection", () => {
  const onSelect = vi.fn();
  render(
    <ControlledPanel
      onSelect={onSelect}
      sessionGroups={[
        makeGroup("current", "Project", [
          makeSession("associated", {
            association: {
              ticketId: "4694275d-ab38-423a-9e3e-17d8316cd070",
              ticketTitle: "Ticket",
              worktreePath: "/project/worktree",
              branch: "feature",
              lastProcessedAt: null,
              processedAtCount: 0,
              awaitingWorktree: null,
              recentWorktrees: [],
            },
          }),
        ]),
      ]}
    />
  );
  expect(
    screen.queryByRole("img", { name: /^Ticket:/ })
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Ticket" }));

  const worktree = screen.getByRole("img", { name: /^Worktree:/ });
  expect(worktree.closest(".hc-mini-history-entry")).not.toBeNull();
  expect(worktree.closest(".hc-mini-history-open")).toBeNull();
  expect(fireEvent.keyDown(worktree, { key: "Enter" })).toBe(true);
  fireEvent.keyDown(worktree, { key: " " });
  expect(onSelect).not.toHaveBeenCalled();
});

it("collapses twenty subagents, supports keyboard toggling, and reveals the active child", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const agents = Array.from({ length: 20 }, (_, i) => ({
    id: `agent-${i}`,
    threadId: `thread-${i}`,
    spawnId: `spawn-${i}`,
    label: `Worker ${i}`,
    detail: "",
    isWorking: i === 0,
  }));
  const props = {
    sessionGroups: [
      makeGroup("current", "Project", [
        makeSession("parent", { title: "Parent" }),
      ]),
    ],
    spawnOutlineBySessionId: new Map([["parent", agents]]),
    onSelect,
  };
  const { rerender } = render(<ControlledPanel {...props} />);
  const toggle = screen.getByRole("button", { name: "Subagents for Parent" });

  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveTextContent("20 subagents");
  expect(toggle).toHaveTextContent("1 working");
  expect(
    screen.queryByRole("button", { name: /^Open spawned agent/ })
  ).not.toBeInTheDocument();

  toggle.focus();
  await user.keyboard("{Enter}");

  expect(
    screen.getAllByRole("button", { name: /^Open spawned agent/ })
  ).toHaveLength(20);
  expect(onSelect).not.toHaveBeenCalled();

  await user.keyboard(" ");
  expect(toggle).toHaveAttribute("aria-expanded", "false");

  rerender(<ControlledPanel {...props} activeProviderThreadId="thread-19" />);
  expect(
    screen.getByRole("button", {
      name: "Open spawned agent Worker 19 from Parent",
    })
  ).toHaveAttribute("aria-current", "true");

  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
});

it("renders unassociated chats together after every ticket group", () => {
  render(
    <ControlledPanel
      sessionGroups={[
        makeGroup("current", "Project", [
          makeSession("first-loose"),
          makeSession("ticket-a", {
            association: { ticketId: "a", ticketTitle: "A" },
          }),
          makeSession("second-loose"),
          makeSession("ticket-b", {
            association: { ticketId: "b", ticketTitle: "B" },
          }),
        ]),
      ]}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "A" }));
  fireEvent.click(screen.getByRole("button", { name: "B" }));

  expect(
    screen
      .getAllByRole("button", { name: /^Load local chat/ })
      .map((e) => e.textContent)
  ).toEqual(["ticket-a", "ticket-b", "first-loose", "second-loose"]);
  const other = screen.getByRole("region", { name: "Other chats" });
  expect(
    within(other).getByRole("heading", { name: "Other chats" })
  ).toBeInTheDocument();
  expect(
    within(other).getAllByRole("button", { name: /^Load local chat/ })
  ).toHaveLength(2);
});
