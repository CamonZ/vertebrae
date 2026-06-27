import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEntityPanelStore } from "../stores/entityPanelStore";
import { GlobalEntityPanelHost } from "./GlobalEntityPanelHost";

const pipelineState = vi.hoisted(() => ({
  current: {
    summary: null as unknown,
    isLoading: false,
    error: null as string | null,
    refetch: vi.fn(),
  },
}));

vi.mock("../hooks/usePipelineSummary", () => ({
  usePipelineSummary: () => pipelineState.current,
}));

vi.mock("./TaskDetail", () => ({
  TaskDetailPanel: ({
    taskId,
    onClose,
  }: {
    taskId: string | null;
    onClose?: () => void;
  }) => (
    <section data-testid="task-detail-panel">
      <span>{taskId}</span>
      <button type="button" onClick={onClose}>
        Close task
      </button>
    </section>
  ),
}));

vi.mock("./panels", async () => {
  const actual = await vi.importActual<typeof import("./panels")>("./panels");
  return {
    ...actual,
    FloatingDetailPanel: ({
      children,
      testId,
    }: {
      children: ReactNode;
      testId?: string;
    }) => <aside data-testid={testId}>{children}</aside>,
  };
});

vi.mock("./WorkflowAtlas", () => ({
  buildAtlasModel: (summary: { model: unknown }) => summary.model,
  WorkflowInspector: ({ workflowId }: { workflowId: string }) => (
    <section data-testid="workflow-inspector">{workflowId}</section>
  ),
  StepInspector: ({
    workflowId,
    stepId,
  }: {
    workflowId: string;
    stepId: string;
  }) => (
    <section data-testid="step-inspector">
      {workflowId}:{stepId}
    </section>
  ),
}));

const atlasModel = {
  workflows: [{ id: "wf-1" }],
  steps: [{ id: "wf-1.step-1", workflowId: "wf-1", stepId: "step-1" }],
  edges: [],
};

describe("GlobalEntityPanelHost", () => {
  beforeEach(() => {
    useEntityPanelStore.getState().reset();
    pipelineState.current = {
      summary: { model: atlasModel },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  });

  it("renders the task side panel for task entity selections", async () => {
    const user = userEvent.setup();
    useEntityPanelStore.getState().openTask("task-123");

    render(<GlobalEntityPanelHost />);

    expect(screen.getByTestId("task-detail-panel")).toHaveTextContent(
      "task-123"
    );

    await user.click(screen.getByRole("button", { name: /close task/i }));

    expect(useEntityPanelStore.getState().selection).toBeNull();
  });

  it("renders the workflow inspector for workflow entity selections", () => {
    useEntityPanelStore.getState().openWorkflow("wf-1");

    render(<GlobalEntityPanelHost />);

    expect(screen.getByTestId("global-entity-panel")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-inspector")).toHaveTextContent("wf-1");
  });

  it("resolves a bare step id to the step inspector side panel", () => {
    useEntityPanelStore.getState().openStep("step-1");

    render(<GlobalEntityPanelHost />);

    expect(screen.getByTestId("step-inspector")).toHaveTextContent(
      "wf-1:step-1"
    );
  });
});
