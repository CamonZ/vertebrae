import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { render, screen } from "../test/test-utils";
import { AllWorkflowsPipeline } from "./AllWorkflowsPipeline";

vi.mock("../bindings", () => ({
  commands: {
    getPipelineSummary: vi.fn(),
    getWebsocketStatus: vi.fn().mockResolvedValue({
      status: "ok",
      data: "connected",
    }),
  },
  events: {
    taskChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    stepExecutionChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { commands } from "../bindings";

function makeStep(
  id: string,
  workflowId: string,
  name: string,
  order: number,
  taskCounts = { epic: 0, ticket: 0, task: 0 },
  runningCount = 0,
) {
  return {
    id,
    name,
    workflow_id: workflowId,
    goal: null,
    step_order: order,
    step_type: "execute",
    is_final: false,
    transitions_to: [] as string[],
    task_counts: taskCounts,
    running_count: runningCount,
  };
}

describe("AllWorkflowsPipeline + usePipelineSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders workflow names from getPipelineSummary", async () => {
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [
          {
            id: "wf-1",
            name: "Pipeline Alpha",
            description: null,
            initial_step_id: "s1",
            kanban_column: null,
            is_default: true,
            display_order: 0,
            workflow_steps: [
              makeStep("s1", "wf-1", "backlog", 0, { epic: 1, ticket: 2, task: 3 }, 1),
              makeStep("s2", "wf-1", "in_progress", 1),
            ],
            transitions: [],
          },
          {
            id: "wf-2",
            name: "Pipeline Beta",
            description: null,
            initial_step_id: "s3",
            kanban_column: null,
            is_default: false,
            display_order: 1,
            workflow_steps: [makeStep("s3", "wf-2", "todo", 0)],
            transitions: [],
          },
        ],
      },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("Pipeline Alpha")).toBeInTheDocument();
      expect(screen.getByText("Pipeline Beta")).toBeInTheDocument();
    });
    expect(screen.getByText("2 workflows visualized")).toBeInTheDocument();
    // The summary may be fetched more than once in test mode (StrictMode +
    // visibilitychange listeners can refetch); we just want at least one call.
    expect(
      vi.mocked(commands.getPipelineSummary).mock.calls.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("shows empty state when no workflows are returned", async () => {
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "ok",
      data: { workflows: [] },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("No workflows yet")).toBeInTheDocument();
    });
  });

  it("shows error state when getPipelineSummary fails", async () => {
    vi.mocked(commands.getPipelineSummary).mockResolvedValue({
      status: "error",
      error: { message: "Connection refused" },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("Error Loading Workflows")).toBeInTheDocument();
      expect(screen.getByText("Connection refused")).toBeInTheDocument();
    });
  });
});
