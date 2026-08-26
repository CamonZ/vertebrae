import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TracesExplorerButton } from "./TracesExplorerButton";
import type { ExecutionRollups } from "../../utils";
import { useEntityPanelStore } from "../../stores/entityPanelStore";

const navigateMock = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

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
  useSubtreeExecutions: () => ({ rollups, isLoading: false, error: null }),
}));

describe("TracesExplorerButton", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    useEntityPanelStore.getState().reset();
    rollups = { ...emptyRollups, totalRuns: 10, totalAttempts: 104 };
  });

  it("renders the live subtree run/attempt counts", () => {
    render(<TracesExplorerButton taskId="task-1" />);
    const button = screen.getByTestId("task-detail-traces");
    expect(button).toHaveTextContent(
      "Explore 10 subtree runs · 104 executions"
    );
  });

  it("pluralizes a single run and a single attempt", () => {
    rollups = { ...emptyRollups, totalRuns: 1, totalAttempts: 1 };
    render(<TracesExplorerButton taskId="task-1" />);
    expect(screen.getByTestId("task-detail-traces")).toHaveTextContent(
      "Explore 1 subtree run · 1 execution"
    );
  });

  it("navigates to the in-app traces route when docked", () => {
    useEntityPanelStore.getState().openTask("task-42");
    render(<TracesExplorerButton taskId="task-42" />);
    fireEvent.click(screen.getByTestId("task-detail-traces"));
    expect(navigateMock).toHaveBeenCalledWith("/traces/task-42");
    expect(useEntityPanelStore.getState().selection).toBeNull();
  });
});
