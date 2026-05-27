import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
    prompt: null,
    step_type: "execute",
    output_schema: null,
    created_at: null,
    updated_at: null,
    agent_config: {
      model: null,
      codex_model_provider: null,
      fallback_model: null,
      reasoning_effort: null,
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
      applyUpdate: vi.fn(),
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
        applyUpdate: vi.fn(),
      });

      const { container } = render(
        <StepDetailPanel stepId="step-test" allSteps={[]} />
      );
      expect(container.firstChild).toBeNull();
    });

    it("renders panel header with 'Step Configuration' title", () => {
      const step = createStep({
        id: "860cde1b-9093-42ff-a19d-7453f3b7891b",
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId={step.id!} allSteps={[]} />);

      expect(screen.getByText("Step Configuration")).toBeInTheDocument();
      expect(screen.getByTestId("step-detail-id")).toHaveTextContent(
        "860cde1b"
      );
      expect(screen.queryByText(step.id!)).not.toBeInTheDocument();
    });

    it("renders the step side panel ID as an eight-character short ID", () => {
      const step = createStep({ id: "abcdef12-3456-7890-abcd-ef1234567890" });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(
        <StepDetailPanel
          stepId="abcdef12-3456-7890-abcd-ef1234567890"
          allSteps={[]}
        />
      );

      expect(screen.getByTestId("step-detail-id")).toHaveTextContent(
        "abcdef12"
      );
      expect(
        screen.queryByText("abcdef12-3456-7890-abcd-ef1234567890")
      ).not.toBeInTheDocument();
    });

    it("renders step name in editable field", () => {
      const step = createStep({ name: "Development" });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
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
        applyUpdate: vi.fn(),
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
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(
        screen.getByText("Complete the implementation task")
      ).toBeInTheDocument();
    });

    it("displays agents section with count", () => {
      const step = createStep({ agents: [".claude/agents/reviewer.md"] });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Agents")).toBeInTheDocument();
      expect(
        screen.getByText(".claude/agents/reviewer.md")
      ).toBeInTheDocument();
    });

    it("displays skills section with count", () => {
      const step = createStep({ skills: ["code-review", "security-audit"] });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Skills")).toBeInTheDocument();
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
        applyUpdate: vi.fn(),
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
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[step1, step2]} />);
      expect(screen.getByText("Transitions")).toBeInTheDocument();
      expect(screen.getByText("Step 1")).toBeInTheDocument();
      expect(screen.getByText("Step 2")).toBeInTheDocument();
    });

    it("displays model section", () => {
      const step = createStep({
        agent_config: {
          model: "opus",
          codex_model_provider: null,
          fallback_model: null,
          reasoning_effort: null,
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
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Model")).toBeInTheDocument();
      expect(screen.getByText("opus")).toBeInTheDocument();
    });

    it("displays reasoning effort with the primary model when configured", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config!,
          model: "gpt-5.5",
          codex_model_provider: null,
          reasoning_effort: "medium",
        },
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);

      expect(screen.getByText("gpt-5.5:medium")).toBeInTheDocument();
      expect(screen.queryByText("medium")).not.toBeInTheDocument();
    });

    it("does not render a reasoning effort suffix when absent", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config!,
          model: "gpt-5.5",
          codex_model_provider: null,
          reasoning_effort: null,
        },
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);

      expect(screen.getByText("gpt-5.5")).toBeInTheDocument();
      expect(screen.queryByText("gpt-5.5:medium")).not.toBeInTheDocument();
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
        applyUpdate: vi.fn(),
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
      expect(
        screen.getByText(/Are you sure you want to delete/)
      ).toBeInTheDocument();
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

      render(
        <StepDetailPanel
          stepId="step-test"
          allSteps={[]}
          onDeleted={onDeleted}
        />
      );

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
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} onClose={onClose} />
      );
      expect(screen.getByLabelText("Close panel")).toBeInTheDocument();
    });

    it("calls onClose when close button is clicked", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} onClose={onClose} />
      );

      const closeButton = screen.getByLabelText("Close panel");
      await user.click(closeButton);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not render close button when onClose is not provided", () => {
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.queryByLabelText("Close panel")).not.toBeInTheDocument();
    });
  });

  describe("back button", () => {
    it("renders back button when onBack is provided", () => {
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} onBack={vi.fn()} />
      );
      expect(screen.getByLabelText("Go back")).toBeInTheDocument();
    });

    it("calls onBack when back button is clicked", async () => {
      const user = userEvent.setup();
      const onBack = vi.fn();
      render(
        <StepDetailPanel stepId="step-test" allSteps={[]} onBack={onBack} />
      );

      await user.click(screen.getByLabelText("Go back"));

      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("does not render back button when onBack is not provided", () => {
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.queryByLabelText("Go back")).not.toBeInTheDocument();
    });
  });

  describe("configuration", () => {
    it("displays all step configuration sections", () => {
      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);

      expect(screen.getByText("Overview")).toBeInTheDocument();
      expect(screen.getByText(/Agents/)).toBeInTheDocument();
      expect(screen.getByText(/Skills/)).toBeInTheDocument();
      expect(screen.getByText(/Transitions/)).toBeInTheDocument();
      expect(screen.getByText("Model")).toBeInTheDocument();
      expect(screen.getByText("Timeline")).toBeInTheDocument();
    });

    it("displays step name and goal", () => {
      const step = createStep({
        name: "Review Code",
        goal: "Check for security issues",
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Review Code")).toBeInTheDocument();
      expect(screen.getByText("Check for security issues")).toBeInTheDocument();
    });

    it("displays prompt when set", () => {
      const step = createStep({
        prompt: "Review the pull request for correctness and style",
      });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Prompt")).toBeInTheDocument();
      expect(
        screen.getByText("Review the pull request for correctness and style")
      ).toBeInTheDocument();
    });

    it("edits long prompt templates with a tall resizable textarea and visible controls", async () => {
      const longPrompt = [
        "Review this workflow step.",
        '{% if task.level == "epic" %}',
        "Check the epic outcome and child ticket sequencing.",
        "{% else %}",
        "Check the ticket implementation and verification evidence.",
        "{% endif %}",
        "Return a concise result with concrete blockers.",
      ].join("\n\n");
      const step = createStep({ prompt: longPrompt });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });
      vi.mocked(bindings.commands.updateStep).mockResolvedValue({
        status: "ok",
        data: null,
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByTestId("prompt-liquid-display")).toBeInTheDocument();

      await userEvent.click(screen.getByTestId("prompt-liquid-display"));

      const textarea = screen.getByRole("textbox");
      expect(textarea).toHaveValue(longPrompt);
      expect(textarea).toHaveAttribute("rows", "12");
      expect(textarea).toHaveClass("resize-y", "font-mono");
      expect(screen.getByRole("button", { name: /save/i })).toBeVisible();
      expect(screen.getByRole("button", { name: /cancel/i })).toBeVisible();

      await userEvent.type(textarea, "\n\nAdditional verification note.");
      await userEvent.keyboard("{Control>}{Enter}{/Control}");

      await waitFor(() => {
        expect(bindings.commands.updateStep).toHaveBeenCalledWith(
          expect.objectContaining({
            step_id: "step-test",
            prompt: `${longPrompt}\n\nAdditional verification note.`,
          })
        );
      });
    });

    it("shows prompt section with placeholder when prompt is null", () => {
      const step = createStep({ prompt: null });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Prompt")).toBeInTheDocument();
      expect(screen.getByText("Click to add prompt...")).toBeInTheDocument();
    });

    it("displays step type badge with 'execute' for execute steps", () => {
      const step = createStep({ step_type: "execute" });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      const badge = screen.getByTestId("step-type-badge");
      expect(badge).toHaveTextContent("execute");
    });

    it("displays step type badge with 'evaluate' for evaluate steps", () => {
      const step = createStep({ step_type: "evaluate" });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      const badge = screen.getByTestId("step-type-badge");
      expect(badge).toHaveTextContent("evaluate");
      expect(badge.className).toContain("--color-info");
    });

    it("displays step type badge with 'route' for route steps", () => {
      const step = createStep({ step_type: "route" });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      const badge = screen.getByTestId("step-type-badge");
      expect(badge).toHaveTextContent("route");
      expect(badge.className).toContain("--color-warn");
    });

    it("displays step type badge with 'human_input' for human input steps", () => {
      const step = createStep({ step_type: "human_input" });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      const badge = screen.getByTestId("step-type-badge");
      expect(badge).toHaveTextContent("human_input");
      expect(badge).not.toHaveTextContent("execute");
      expect(badge.className).toContain("--color-ok");
    });

    it("displays unsupported step types without falling back to execute", () => {
      const step = createStep({ step_type: { unsupported: "manual_gate" } });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      const badge = screen.getByTestId("step-type-badge");
      expect(badge).toHaveTextContent("unsupported:manual_gate");
      expect(badge).not.toHaveTextContent("execute");
      expect(badge.className).toContain("--color-err");
    });

    it("displays output schema as a type tree when present", () => {
      const schema = {
        type: "object",
        required: ["result"],
        properties: {
          result: { type: "string", description: "The output" },
          score: { type: "number" },
        },
      };
      const step = createStep({ output_schema: schema });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.getByText("Output Schema")).toBeInTheDocument();
      expect(screen.getByTestId("schema-tree")).toBeInTheDocument();
      // Property names rendered
      expect(screen.getByText("result")).toBeInTheDocument();
      expect(screen.getByText("score")).toBeInTheDocument();
      // Types rendered
      expect(screen.getAllByText("string").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("number").length).toBeGreaterThanOrEqual(1);
      // Description rendered
      expect(screen.getByText("The output")).toBeInTheDocument();
    });

    it("does not display output schema section when output_schema is null", () => {
      const step = createStep({ output_schema: null });
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      expect(screen.queryByText("Output Schema")).not.toBeInTheDocument();
    });

    it("defaults step type to execute when step_type is undefined", () => {
      const step = createStep();
      // Remove step_type to simulate undefined
      delete (step as Record<string, unknown>).step_type;
      vi.mocked(hooks.useStep).mockReturnValue({
        step,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        applyUpdate: vi.fn(),
      });

      render(<StepDetailPanel stepId="step-test" allSteps={[]} />);
      const badge = screen.getByTestId("step-type-badge");
      expect(badge).toHaveTextContent("execute");
    });
  });
});
