import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepDetailPanel } from "./StepDetailPanel";
import type { Step } from "../../bindings";
import * as hooks from "../../hooks";
import * as bindings from "../../bindings";

// Mock the hooks
vi.mock("../../hooks", () => ({
  useStep: vi.fn(),
  useStepChangeListener: vi.fn(),
}));

// Mock the bindings commands
vi.mock("../../bindings", async () => {
  const actual = await vi.importActual("../../bindings");
  return {
    ...actual,
    commands: {
      updateStep: vi.fn(),
      deleteStep: vi.fn(),
    },
  };
});

// confirm is already defined globally, so we just mock it in tests

// Helper to create a step with defaults
function createStep(overrides?: Partial<Step>): Step {
  return {
    id: "step-test",
    name: "Test Step",
    workflow_id: "workflow-1",
    order: 0,
    is_final: false,
    transitions_to: [],
    agents: [],
    skills: [],
    goal: null,
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

describe("StepDetailPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock setup
    vi.mocked(hooks.useStep).mockReturnValue({
      step: createStep(),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(hooks.useStepChangeListener).mockReturnValue(undefined);
  });

  describe("rendering", () => {
    it("returns null when step is not loaded", () => {
      vi.mocked(hooks.useStep).mockReturnValue({
        step: null,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      const { container } = render(
        <StepDetailPanel stepId="step-test" allSteps={[]} />
      );
      expect(container.firstChild).toBeNull();
    });

    it("renders panel header with 'Step Configuration' title", () => {
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Step Configuration")).toBeInTheDocument();
    });

    it("renders step name in editable field", () => {
      const step = createStep({ name: "Development" });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Development")).toBeInTheDocument();
    });

    it("renders step order badge (1-indexed)", () => {
      const step = createStep({ order: 2 });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      // Order 2 displays as "3" (1-indexed)
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("displays goal when configured", () => {
      const step = createStep({ goal: "Complete the implementation task" });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Complete the implementation task")).toBeInTheDocument();
    });

    it("displays agents section with count", () => {
      const step = createStep({ agents: [".claude/agents/reviewer.md"] });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Agents (1)")).toBeInTheDocument();
      expect(screen.getByText(".claude/agents/reviewer.md")).toBeInTheDocument();
    });

    it("displays skills section with count", () => {
      const step = createStep({ skills: ["code-review", "security-audit"] });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Skills (2)")).toBeInTheDocument();
      expect(screen.getByText("code-review")).toBeInTheDocument();
      expect(screen.getByText("security-audit")).toBeInTheDocument();
    });

    it("displays final step toggle", () => {
      const step = createStep({ is_final: true });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText(/final step/i)).toBeInTheDocument();
    });

    it("displays transitions section", () => {
      const step1 = createStep({ id: "step-1", name: "Step 1" });
      const step2 = createStep({ id: "step-2", name: "Step 2" });
      const step = createStep({
        transitions_to: ["step-1", "step-2"],
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[step1, step2]} />);
      expect(screen.getByText("Transitions (2)")).toBeInTheDocument();
      expect(screen.getByText("Step 1")).toBeInTheDocument();
      expect(screen.getByText("Step 2")).toBeInTheDocument();
    });

    it("displays model section", () => {
      const step = createStep({
        agent_config: {
          model: "opus",
          fallback_model: null,
          system_prompt: null,
          append_system_prompt: null,
          tools: ["browser"],
          allowed_tools: [],
          disallowed_tools: [],
          permission_mode: null,
          max_budget_usd: null,
          mcp_config: [],
          plugin_dirs: [],
          agents: null,
          json_schema: null,
        },
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Model")).toBeInTheDocument();
      expect(screen.getByText("opus")).toBeInTheDocument();
    });

    it("displays timeline section", () => {
      const now = new Date().toISOString();
      const step = createStep({
        created_at: now,
        updated_at: now,
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Timeline")).toBeInTheDocument();
    });
  });

  describe("delete", () => {
    it("shows delete button", () => {
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByLabelText("Delete step")).toBeInTheDocument();
    });

    it("shows confirmation section when delete is clicked", async () => {
      const user = userEvent.setup();

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);

      const deleteButton = screen.getByLabelText("Delete step");
      await user.click(deleteButton);

      // Confirmation section should appear
      expect(screen.getByText("Delete Step?")).toBeInTheDocument();
      expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();
      expect(screen.getByText("Confirm Delete")).toBeInTheDocument();
      expect(screen.getByText("Cancel")).toBeInTheDocument();
      expect(bindings.commands.deleteStep).not.toHaveBeenCalled();
    });

    it("hides confirmation when cancel is clicked", async () => {
      const user = userEvent.setup();

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);

      // Show confirmation
      await user.click(screen.getByLabelText("Delete step"));
      expect(screen.getByText("Delete Step?")).toBeInTheDocument();

      // Click cancel
      await user.click(screen.getByText("Cancel"));

      // Confirmation should be hidden
      expect(screen.queryByText("Delete Step?")).not.toBeInTheDocument();
    });

    it("calls deleteStep when confirmed", async () => {
      const user = userEvent.setup();
      const onDeleted = vi.fn();

      vi.mocked(bindings.commands.deleteStep).mockResolvedValue({
        status: "ok",
        data: null,
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} onDeleted={onDeleted} />);

      // Show confirmation
      await user.click(screen.getByLabelText("Delete step"));

      // Confirm delete
      await user.click(screen.getByText("Confirm Delete"));

      expect(bindings.commands.deleteStep).toHaveBeenCalledWith("step-test");
      expect(onDeleted).toHaveBeenCalledTimes(1);
    });
  });

  describe("close button", () => {
    it("renders close button when onClose is provided", () => {
      const onClose = vi.fn();
      render(<StepDetailPanel stepId="step-test" allSteps={[]} onClose={onClose} />);
      expect(screen.getByLabelText("Close panel")).toBeInTheDocument();
    });

    it("calls onClose when close button is clicked", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<StepDetailPanel stepId="step-test" allSteps={[]} onClose={onClose} />);

      const closeButton = screen.getByLabelText("Close panel");
      await user.click(closeButton);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not render close button when onClose is not provided", () => {
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.queryByLabelText("Close panel")).not.toBeInTheDocument();
    });
  });
});
