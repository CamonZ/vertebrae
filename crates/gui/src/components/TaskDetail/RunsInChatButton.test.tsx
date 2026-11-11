import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RunsInChatButton } from "./RunsInChatButton";
import type { ExecutionRollups } from "../../utils";
import { useEntityPanelStore } from "../../stores/entityPanelStore";

const mocks = vi.hoisted(() => ({
  resolveTaskRunTarget: vi.fn(),
  openRunInChat: vi.fn(),
}));

vi.mock("../../utils/openRunInChat", () => mocks);

const emptyRollups: ExecutionRollups = {
  totalRuns: 0,
  totalAttempts: 0,
  totalCost: 0,
  totalTokens: 0,
  rawInputTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  totalWallTimeMs: 0,
};
let rollups: ExecutionRollups = emptyRollups;
vi.mock("../../hooks/useSubtreeExecutions", () => ({
  useSubtreeExecutions: () => ({
    rollups,
    executions: [],
    isLoading: false,
    error: null,
  }),
}));

describe("RunsInChatButton", () => {
  beforeEach(() => {
    mocks.resolveTaskRunTarget.mockReset();
    mocks.openRunInChat.mockReset();
    useEntityPanelStore.getState().reset();
    rollups = { ...emptyRollups, totalRuns: 10, totalAttempts: 104 };
  });

  it("renders the live subtree run/attempt counts", () => {
    render(<RunsInChatButton taskId="task-1" />);
    expect(screen.getByTestId("task-detail-runs-in-chat")).toHaveTextContent(
      "Open in chat · 10 subtree runs · 104 executions"
    );
  });

  it("pluralizes a single run and a single attempt", () => {
    rollups = { ...emptyRollups, totalRuns: 1, totalAttempts: 1 };
    render(<RunsInChatButton taskId="task-1" />);
    expect(screen.getByTestId("task-detail-runs-in-chat")).toHaveTextContent(
      "1 subtree run · 1 execution"
    );
  });

  it("is disabled when the subtree has no runs", () => {
    rollups = emptyRollups;
    render(<RunsInChatButton taskId="task-1" />);
    expect(screen.getByTestId("task-detail-runs-in-chat")).toBeDisabled();
  });

  it("opens the resolved run in the chat and closes the detail panel", async () => {
    mocks.resolveTaskRunTarget.mockResolvedValue({
      taskId: "task-42",
      runId: "run-7",
    });
    useEntityPanelStore.getState().openTask("task-42");
    render(<RunsInChatButton taskId="task-42" />);

    fireEvent.click(screen.getByTestId("task-detail-runs-in-chat"));

    await waitFor(() =>
      expect(mocks.openRunInChat).toHaveBeenCalledWith({
        taskId: "task-42",
        runId: "run-7",
      })
    );
    expect(mocks.resolveTaskRunTarget).toHaveBeenCalledWith("task-42", []);
    expect(useEntityPanelStore.getState().selection).toBeNull();
  });

  it("reports when there is no run to open", async () => {
    mocks.resolveTaskRunTarget.mockResolvedValue(null);
    render(<RunsInChatButton taskId="task-1" />);

    fireEvent.click(screen.getByTestId("task-detail-runs-in-chat"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No runs to open yet."
    );
    expect(mocks.openRunInChat).not.toHaveBeenCalled();
  });
});
