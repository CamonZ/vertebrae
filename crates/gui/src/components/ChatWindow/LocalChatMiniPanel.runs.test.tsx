import { StatefulMiniPanel } from "../../test/miniPanel";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createMockStepExecution,
  createMockTask,
  createMockTaskRun,
} from "../../test/test-utils";
import type { Task } from "../../bindings";
import type {
  LocalChatRunRow,
  LocalChatSessionGroup,
} from "../../utils/localChatSessionGroups";
import { LocalChatMiniPanel } from "./LocalChatMiniPanel";

const mocks = vi.hoisted(() => ({
  rows: [] as LocalChatRunRow[],
  hidden: 0,
  tasksById: new Map<string, Task>(),
  enabled: [] as boolean[],
  hasMore: false,
  loadingMore: false,
  loadMore: vi.fn(),
  isError: false,
  isLoading: false,
  isFetching: false,
  retry: vi.fn(),
}));

vi.mock("../../hooks/useHistoryRuns", () => ({
  useHistoryRuns: ({ enabled }: { enabled: boolean }) => {
    mocks.enabled.push(enabled);
    return {
      rows: enabled ? mocks.rows : [],
      hiddenCompletedCount: mocks.hidden,
      tasksById: mocks.tasksById,
      hasMore: mocks.hasMore,
      loadingMore: mocks.loadingMore,
      loadMore: mocks.loadMore,
      isError: mocks.isError,
      isLoading: mocks.isLoading,
      isFetching: mocks.isFetching,
      retry: mocks.retry,
    };
  },
}));

vi.mock("../../hooks", () => ({
  useRunTrace: () => ({
    stepExecutions: [
      createMockStepExecution({
        id: "exec-2",
        step_name: "review",
        step_type: "llm_inference",
        started_at: "2026-01-01T00:02:00Z",
      }),
      createMockStepExecution({
        id: "exec-1",
        step_name: "implement",
        started_at: "2026-01-01T00:01:00Z",
      }),
    ],
    isLoading: false,
    error: null,
  }),
}));

function row(id: string, taskId: string): LocalChatRunRow {
  return {
    id,
    taskId,
    run: createMockTaskRun({ id, task_id: taskId, status: "waiting" }),
    label: "Delivery run",
    updatedAt: "2026-01-02T00:00:00Z",
    completed: false,
  };
}

const project: LocalChatSessionGroup = {
  id: "current",
  label: "Current",
  projectId: "project-current",
  projectPath: "/repo",
  isCurrentProject: true,
  isFallback: false,
  sessions: [],
};

function renderPanel(
  overrides: Partial<Parameters<typeof LocalChatMiniPanel>[0]> = {}
) {
  const props = {
    width: 272,
    activeSessionId: "",
    searchQuery: "",
    onSearchQueryChange: vi.fn(),
    selectedProjectId: "current",
    onSelectProject: vi.fn(),
    deleteError: null,
    projectWarning: null,
    sessionGroups: [project],
    spawnOutlineBySessionId: new Map(),
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onSelectRun: vi.fn(),
    onSelectRunStep: vi.fn(),
    ...overrides,
  };
  render(<StatefulMiniPanel {...props} />);
  return props;
}

describe("LocalChatMiniPanel run rows", () => {
  beforeEach(() => {
    mocks.rows = [row("run-12345678", "task-1")];
    mocks.hidden = 0;
    mocks.enabled = [];
    mocks.hasMore = false;
    mocks.loadingMore = false;
    mocks.loadMore = vi.fn();
    mocks.isError = false;
    mocks.isLoading = false;
    mocks.isFetching = false;
    mocks.retry = vi.fn();
    mocks.tasksById = new Map([
      [
        "ticket-1",
        createMockTask({ id: "ticket-1", title: "Ticket", level: "ticket" }),
      ],
      [
        "task-1",
        createMockTask({
          id: "task-1",
          title: "Parser task",
          level: "task",
          parent_id: "ticket-1",
        }),
      ],
    ]);
  });

  it("lists runs under their ticket → task groups and opens them", () => {
    const props = renderPanel({ activeRunId: "run-12345678" });

    const ticket = screen.getByRole("button", { name: "Ticket" });
    expect(ticket).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Parser task" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    const open = screen.getByRole("button", {
      name: "Load run Delivery run run-1234 into active pane",
    });
    expect(open).toHaveAttribute("aria-current", "true");
    fireEvent.click(open);
    expect(props.onSelectRun).toHaveBeenCalledWith(mocks.rows[0]);
  });

  it("jumps to a step from the run's step outline", () => {
    const props = renderPanel({ activeRunId: "run-12345678" });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Steps for Delivery run run-1234",
      })
    );
    const steps = screen.getAllByRole("button", { name: /Jump to step/ });
    expect(steps.map((step) => step.textContent)).toEqual([
      "implement",
      "reviewllm_inference",
    ]);

    fireEvent.click(steps[1]);
    expect(props.onSelectRunStep).toHaveBeenCalledWith(mocks.rows[0], "exec-2");
  });

  it("hides the older-runs control once history is fully loaded", () => {
    renderPanel();
    expect(
      screen.queryByTestId("local-chat-history-load-more")
    ).not.toBeInTheDocument();
  });

  it("offers older history and disables the control while it loads", () => {
    mocks.hasMore = true;
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    expect(mocks.loadMore).toHaveBeenCalledTimes(1);
  });

  it("shows older-history loading progress", () => {
    mocks.hasMore = true;
    mocks.loadingMore = true;
    renderPanel();

    expect(screen.getByTestId("local-chat-history-load-more")).toBeDisabled();
    expect(
      screen.getByTestId("local-chat-history-load-more")
    ).toHaveTextContent("Loading…");
  });

  it("counts runs in group totals and shows them without chats", () => {
    renderPanel({ activeRunId: "run-12345678" });

    expect(screen.queryByTestId("local-chat-history-empty")).toBeNull();
    const region = screen.getByTestId("local-chat-history-scroll-region");
    expect(within(region).getByText("waiting")).toBeInTheDocument();
  });

  it("does not request runs for another project or without a run handler", () => {
    renderPanel({
      sessionGroups: [{ ...project, isCurrentProject: false }],
    });
    renderPanel({ onSelectRun: undefined });

    expect(mocks.enabled.every((enabled) => !enabled)).toBe(true);
  });

  it("offers completed history when only completed runs match", () => {
    mocks.rows = [];
    mocks.hidden = 2;
    renderPanel();

    expect(screen.getByText(/No active chats/)).toBeInTheDocument();
  });

  it("shows a history failure with retry instead of an empty-success message", () => {
    mocks.rows = [];
    mocks.isError = true;
    renderPanel();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load run history."
    );
    expect(screen.queryByTestId("local-chat-history-empty")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry run history" }));
    expect(mocks.retry).toHaveBeenCalledOnce();
  });

  it("keeps loaded runs visible during a failed refresh and disables duplicate retries", () => {
    mocks.isError = true;
    mocks.isFetching = true;
    renderPanel({ activeRunId: "run-12345678" });

    expect(
      screen.getByRole("button", { name: "Retry run history" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Load run Delivery run run-1234 into active pane",
      })
    ).toBeInTheDocument();
  });

  it("announces loading without claiming history is empty", () => {
    mocks.rows = [];
    mocks.isLoading = true;
    renderPanel();

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading run history…"
    );
    expect(screen.queryByTestId("local-chat-history-empty")).toBeNull();
  });
});
