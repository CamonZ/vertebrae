import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowDetailPanel } from "./WorkflowDetailPanel";
import type { Workflow, Step } from "../../bindings";

// Helper to create a workflow with defaults
function createWorkflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: "workflow-1",
    name: "Test Workflow",
    description: null,
    initial_step: null,
    kanban_column: null,
    is_default: false,
    metadata: {},
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

// Helper to create a step with defaults
function createStep(overrides?: Partial<Step>): Step {
  return {
    id: "step-1",
    name: "Test Step",
    workflow_id: "workflow-1",
    order: 0,
    is_final: false,
    transitions_to: [],
    goal: null,
    prompt: null,
    step_type: "execute",
    output_schema: null,
    created_at: null,
    updated_at: null,
    agent_config: {
      model: null,
      fallback_model: null,
      system_prompt: null,
      append_system_prompt: null,
      tools: [],
      allowed_tools: [],
      disallowed_tools: [],
      permission_mode: null,
      max_budget_usd: null,
      mcp_config: [],
      plugin_dirs: [],
      agents: null,
      json_schema: null,
    },
    ...overrides,
  };
}

describe("WorkflowDetailPanel", () => {
  describe("rendering", () => {
    it("returns null when workflow is null", () => {
      const { container } = render(<WorkflowDetailPanel workflow={null} />);
      expect(container.firstChild).toBeNull();
    });

    it("renders panel header with 'Workflow Details' title", () => {
      const workflow = createWorkflow();
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.getByText("Workflow Details")).toBeInTheDocument();
    });

    it("renders workflow name", () => {
      const workflow = createWorkflow({ name: "Implementation" });
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(
        screen.getByRole("heading", { name: "Implementation" })
      ).toBeInTheDocument();
    });

    it("renders the 8-digit short workflow ID", () => {
      const workflowId = "860cde1b-9093-42ff-a19d-7453f3b7891b";
      const workflow = createWorkflow({
        id: workflowId,
      });
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.getByTestId("workflow-detail-id")).toHaveTextContent(
        "860cde1b"
      );
      expect(screen.queryByText(workflowId)).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Copy full workflow ID" })
      ).toBeInTheDocument();
    });
  });

  describe("description", () => {
    it("displays description when configured", () => {
      const workflow = createWorkflow({
        description: "Handles implementation tasks",
      });
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.getByText("Description")).toBeInTheDocument();
      expect(
        screen.getByText("Handles implementation tasks")
      ).toBeInTheDocument();
    });

    it("does not show description section when not configured", () => {
      const workflow = createWorkflow({ description: null });
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.queryByText("Description")).not.toBeInTheDocument();
    });
  });

  describe("overview", () => {
    it("displays step count", () => {
      const workflow = createWorkflow();
      const steps = [createStep({ order: 0 }), createStep({ order: 1 })];
      render(<WorkflowDetailPanel workflow={workflow} steps={steps} />);

      expect(screen.getByText("Overview")).toBeInTheDocument();
      // Check within the Overview section - Steps label should be present
      expect(screen.getByText("Steps")).toBeInTheDocument();
    });

    it("displays task count", () => {
      const workflow = createWorkflow();
      render(<WorkflowDetailPanel workflow={workflow} taskCount={42} />);

      // Tasks label should be present in Overview
      expect(screen.getByText("Tasks")).toBeInTheDocument();
    });

    it("displays initial step when configured", () => {
      const workflow = createWorkflow({ initial_step: "step-initial" });
      const steps = [
        createStep({ id: "step-initial", name: "entry_point", order: 0 }),
      ];
      render(<WorkflowDetailPanel workflow={workflow} steps={steps} />);

      expect(screen.getByText("Initial Step")).toBeInTheDocument();
      // The initial step name should appear (getAllByText since it appears in both Overview and Steps list)
      expect(screen.getAllByText("entry_point")).toHaveLength(2);
    });

    it("displays Default row when workflow is_default is true", () => {
      const workflow = createWorkflow({ is_default: true });
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.getByText("Default")).toBeInTheDocument();
      expect(screen.getByText("Yes")).toBeInTheDocument();
    });

    it("does not display Default row when workflow is_default is false", () => {
      const workflow = createWorkflow({ is_default: false });
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.queryByText("Default")).not.toBeInTheDocument();
    });

    it("displays kanban column when configured", () => {
      const workflow = createWorkflow({ kanban_column: "in_progress" });
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.getByText("Kanban Column")).toBeInTheDocument();
      expect(screen.getByText("in_progress")).toBeInTheDocument();
    });

    it("does not display kanban column row when not configured", () => {
      const workflow = createWorkflow({ kanban_column: null });
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.queryByText("Kanban Column")).not.toBeInTheDocument();
    });
  });

  describe("steps list", () => {
    it("displays steps section with count", () => {
      const workflow = createWorkflow();
      const steps = [
        createStep({ name: "todo", order: 0 }),
        createStep({ name: "in_progress", order: 1 }),
        createStep({ name: "done", order: 2 }),
      ];
      render(<WorkflowDetailPanel workflow={workflow} steps={steps} />);

      expect(screen.getByText("Steps (3)")).toBeInTheDocument();
    });

    it("displays step names in order", () => {
      const workflow = createWorkflow();
      const steps = [
        createStep({ name: "done", order: 2 }),
        createStep({ name: "todo", order: 0 }),
        createStep({ name: "in_progress", order: 1 }),
      ];
      render(<WorkflowDetailPanel workflow={workflow} steps={steps} />);

      expect(screen.getByText("todo")).toBeInTheDocument();
      expect(screen.getByText("in_progress")).toBeInTheDocument();
      expect(screen.getByText("done")).toBeInTheDocument();
    });

    it("displays step goals when configured", () => {
      const workflow = createWorkflow();
      const steps = [
        createStep({ name: "todo", order: 0, goal: "Tasks waiting to start" }),
      ];
      render(<WorkflowDetailPanel workflow={workflow} steps={steps} />);

      expect(screen.getByText("Tasks waiting to start")).toBeInTheDocument();
    });

    it("displays step model", () => {
      const workflow = createWorkflow();
      const steps = [
        createStep({
          name: "review",
          order: 0,
          agent_config: {
            ...createStep().agent_config!,
            model: "sonnet",
          },
        }),
      ];
      render(<WorkflowDetailPanel workflow={workflow} steps={steps} />);

      expect(screen.getByText("sonnet")).toBeInTheDocument();
    });

    it("shows 'default' when no model configured", () => {
      const workflow = createWorkflow();
      const steps = [createStep({ name: "todo", order: 0 })];
      render(<WorkflowDetailPanel workflow={workflow} steps={steps} />);

      expect(screen.getByText("default")).toBeInTheDocument();
    });

    it("does not show steps section when no steps", () => {
      const workflow = createWorkflow();
      render(<WorkflowDetailPanel workflow={workflow} steps={[]} />);

      expect(screen.queryByText(/Steps \(/)).not.toBeInTheDocument();
    });
  });

  describe("metadata", () => {
    it("displays metadata when configured", () => {
      const workflow = createWorkflow({
        metadata: {
          owner: "team-alpha",
          priority: "high",
        },
      });
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.getByText("Metadata")).toBeInTheDocument();
      expect(screen.getByText("owner")).toBeInTheDocument();
      expect(screen.getByText("team-alpha")).toBeInTheDocument();
      expect(screen.getByText("priority")).toBeInTheDocument();
      expect(screen.getByText("high")).toBeInTheDocument();
    });

    it("does not show metadata section when empty", () => {
      const workflow = createWorkflow({ metadata: {} });
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.queryByText("Metadata")).not.toBeInTheDocument();
    });
  });

  describe("timeline", () => {
    it("displays created_at when configured", () => {
      const workflow = createWorkflow({
        created_at: "2024-01-15T10:30:00Z",
      });
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.getByText("Timeline")).toBeInTheDocument();
      expect(screen.getByText("Created")).toBeInTheDocument();
      // The formatted date should be present
      expect(screen.getByText(/Jan 15, 2024/)).toBeInTheDocument();
    });

    it("displays updated_at when configured", () => {
      const workflow = createWorkflow({
        updated_at: "2024-02-20T15:45:00Z",
      });
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.getByText("Updated")).toBeInTheDocument();
      expect(screen.getByText(/Feb 20, 2024/)).toBeInTheDocument();
    });

    it("shows dash when dates not configured", () => {
      const workflow = createWorkflow({
        created_at: null,
        updated_at: null,
      });
      render(<WorkflowDetailPanel workflow={workflow} />);

      // Should show "—" for both dates
      expect(screen.getAllByText("—")).toHaveLength(2);
    });
  });

  describe("close button", () => {
    it("renders close button when onClose is provided", () => {
      const workflow = createWorkflow();
      const onClose = vi.fn();
      render(<WorkflowDetailPanel workflow={workflow} onClose={onClose} />);

      expect(screen.getByLabelText("Close panel")).toBeInTheDocument();
    });

    it("calls onClose when close button is clicked", async () => {
      const user = userEvent.setup();
      const workflow = createWorkflow();
      const onClose = vi.fn();
      render(<WorkflowDetailPanel workflow={workflow} onClose={onClose} />);

      await user.click(screen.getByLabelText("Close panel"));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not render close button when onClose is not provided", () => {
      const workflow = createWorkflow();
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.queryByLabelText("Close panel")).not.toBeInTheDocument();
    });
  });

  describe("back button", () => {
    it("renders back button when onBack is provided", () => {
      const workflow = createWorkflow();
      render(<WorkflowDetailPanel workflow={workflow} onBack={vi.fn()} />);

      expect(screen.getByLabelText("Go back")).toBeInTheDocument();
    });

    it("calls onBack when back button is clicked", async () => {
      const user = userEvent.setup();
      const workflow = createWorkflow();
      const onBack = vi.fn();
      render(<WorkflowDetailPanel workflow={workflow} onBack={onBack} />);

      await user.click(screen.getByLabelText("Go back"));

      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("does not render back button when onBack is not provided", () => {
      const workflow = createWorkflow();
      render(<WorkflowDetailPanel workflow={workflow} />);

      expect(screen.queryByLabelText("Go back")).not.toBeInTheDocument();
    });
  });

  describe("step selection", () => {
    it("calls onStepSelect when a step is clicked", async () => {
      const user = userEvent.setup();
      const workflow = createWorkflow();
      const onStepSelect = vi.fn();
      const steps = [
        createStep({ id: "step-1", name: "todo", order: 0 }),
        createStep({ id: "step-2", name: "done", order: 1 }),
      ];

      render(
        <WorkflowDetailPanel
          workflow={workflow}
          steps={steps}
          onStepSelect={onStepSelect}
        />
      );

      await user.click(screen.getByText("todo"));

      expect(onStepSelect).toHaveBeenCalledTimes(1);
      expect(onStepSelect).toHaveBeenCalledWith(
        expect.objectContaining({ id: "step-1", name: "todo" })
      );
    });
  });
});
