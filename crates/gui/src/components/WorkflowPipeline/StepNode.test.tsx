import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "../../test/test-utils";
import { StepNode, type StepNodeData } from "./StepNode";
import type { AgentConfig, Step, PermissionMode } from "../../bindings";

/**
 * Create a complete AgentConfig with defaults
 */
function createAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    model: null,
    fallback_model: null,
    reasoning_effort: null,
    system_prompt: null,
    append_system_prompt: null,
    agents: null,
    tools: [],
    allowed_tools: [],
    disallowed_tools: [],
    permission_mode: null,
    max_budget_usd: null,
    mcp_config: [],
    plugin_dirs: [],
    json_schema: null,
    ...overrides,
  };
}

/**
 * Create a complete Step with defaults
 */
function createStep(overrides?: Partial<Step>): Step {
  return {
    id: null,
    name: "Test Step",
    workflow_id: "workflow-1",
    goal: null,
    prompt: null,
    agent_config: createAgentConfig({ model: "claude-3-sonnet" }),
    step_type: "execute",
    output_schema: null,
    is_final: false,
    transitions_to: [],
    order: 0,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

// Helper to create step node props
function createStepNodeProps(overrides?: Partial<StepNodeData>) {
  const defaultData: StepNodeData = {
    step: createStep(),
    isFirst: false,
    isLast: false,
    onPlayClick: undefined,
    isExecuting: false,
    ...overrides,
  };

  return {
    id: "step-0",
    type: "stepNode" as const,
    data: defaultData,
    selected: false,
    isConnectable: true,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    dragging: false,
    draggable: true,
    dragHandle: undefined,
    selectable: true,
    deletable: true,
    parentId: undefined,
  };
}

describe("StepNode", () => {
  describe("rendering", () => {
    it("renders step name", () => {
      const props = createStepNodeProps({
        step: createStep({
          name: "Review Step",
          order: 1,
        }),
      });

      render(<StepNode {...props} />);

      expect(screen.getByText("Review Step")).toBeInTheDocument();
    });

    it("renders step order number (1-indexed)", () => {
      const props = createStepNodeProps({
        step: createStep({
          name: "Test",
          order: 2,
          agent_config: createAgentConfig(),
        }),
      });

      render(<StepNode {...props} />);

      // Order is 0-indexed internally, displayed as 1-indexed
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("renders model name when provided", () => {
      const props = createStepNodeProps({
        step: createStep({
          name: "Test",
          order: 0,
          agent_config: createAgentConfig({ model: "claude-3-opus" }),
        }),
      });

      render(<StepNode {...props} />);

      expect(screen.getByText("claude-3-opus")).toBeInTheDocument();
    });

    it("renders model and reasoning effort as one compact value", () => {
      const props = createStepNodeProps({
        step: createStep({
          name: "Test",
          order: 0,
          goal: null,
          agent_config: createAgentConfig({
            model: "gpt-5.5",
            reasoning_effort: "medium",
          }),
        }),
      });

      render(<StepNode {...props} />);

      expect(screen.getByText("gpt-5.5:medium")).toBeInTheDocument();
      expect(screen.queryByText("medium")).not.toBeInTheDocument();
    });
  });

  describe("step type indicators", () => {
    it("shows Entry indicator for first step", () => {
      const props = createStepNodeProps({ isFirst: true, isLast: false });

      render(<StepNode {...props} />);

      expect(screen.getByText("Entry")).toBeInTheDocument();
    });

    it("shows Exit indicator for last step", () => {
      const props = createStepNodeProps({ isFirst: false, isLast: true });

      render(<StepNode {...props} />);

      expect(screen.getByText("Exit")).toBeInTheDocument();
    });

    it("shows Process indicator for middle steps", () => {
      const props = createStepNodeProps({ isFirst: false, isLast: false });

      render(<StepNode {...props} />);

      expect(screen.getByText("Process")).toBeInTheDocument();
    });
  });

  describe("agent config indicators", () => {
    it("shows Prompt badge when system prompt is configured", () => {
      const props = createStepNodeProps({
        step: createStep({
          name: "Test",
          order: 0,
          agent_config: createAgentConfig({
            system_prompt: "You are a helpful assistant",
          }),
        }),
      });

      render(<StepNode {...props} />);

      expect(screen.getByText("Prompt")).toBeInTheDocument();
    });

    it("shows Prompt badge when append_system_prompt is configured", () => {
      const props = createStepNodeProps({
        step: createStep({
          name: "Test",
          order: 0,
          agent_config: createAgentConfig({
            append_system_prompt: "Additional instructions",
          }),
        }),
      });

      render(<StepNode {...props} />);

      expect(screen.getByText("Prompt")).toBeInTheDocument();
    });

    it("shows tool count badge when tools are configured", () => {
      const props = createStepNodeProps({
        step: createStep({
          name: "Test",
          order: 0,
          agent_config: createAgentConfig({
            tools: ["tool1", "tool2"],
            allowed_tools: ["tool3"],
          }),
        }),
      });

      render(<StepNode {...props} />);

      // Total tools: 2 + 1 = 3
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("shows permission mode badge when set", () => {
      const props = createStepNodeProps({
        step: createStep({
          name: "Test",
          order: 0,
          agent_config: createAgentConfig({
            permission_mode: "bypass_permissions" as PermissionMode,
          }),
        }),
      });

      render(<StepNode {...props} />);

      expect(screen.getByText("bypass_permissions")).toBeInTheDocument();
    });
  });

  describe("selection state", () => {
    it("applies selected styles when selected", () => {
      const props = createStepNodeProps();
      const selectedProps = { ...props, selected: true };

      const { container } = render(<StepNode {...selectedProps} />);

      // Should have border-primary class when selected
      const node = container.querySelector(".border-primary");
      expect(node).toBeInTheDocument();
    });
  });

  describe("task count badges", () => {
    it("renders task count badges when taskCounts provided", () => {
      const props = createStepNodeProps({
        taskCounts: { epic: 2, ticket: 3, task: 1 },
      });

      render(<StepNode {...props} />);

      // Check for title attributes which are unique to task count badges
      expect(screen.getByTitle("2 epic(s)")).toBeInTheDocument();
      expect(screen.getByTitle("3 ticket(s)")).toBeInTheDocument();
      expect(screen.getByTitle("1 task(s)")).toBeInTheDocument();
    });

    it("does not render task count badges when taskCounts not provided", () => {
      const props = createStepNodeProps();

      const { container } = render(<StepNode {...props} />);
      const taskCountContainer = container.querySelector(".ml-auto.flex.gap-2");
      expect(taskCountContainer).not.toBeInTheDocument();
    });

    it("only shows non-zero task counts", () => {
      const props = createStepNodeProps({
        taskCounts: { epic: 2, ticket: 0, task: 0 },
      });

      render(<StepNode {...props} />);

      // Check for epic badge
      expect(screen.getByTitle("2 epic(s)")).toBeInTheDocument();
      // Ticket and task should not have title attributes since counts are 0
      expect(screen.queryByTitle("0 ticket(s)")).not.toBeInTheDocument();
      expect(screen.queryByTitle("0 task(s)")).not.toBeInTheDocument();
    });

    it("shows correct title attributes on task count badges", () => {
      const props = createStepNodeProps({
        taskCounts: { epic: 2, ticket: 3, task: 1 },
      });

      render(<StepNode {...props} />);

      // Check for correct title attributes
      const epicBadge = screen.getByTitle("2 epic(s)");
      expect(epicBadge).toBeInTheDocument();

      const ticketBadge = screen.getByTitle("3 ticket(s)");
      expect(ticketBadge).toBeInTheDocument();

      const taskBadge = screen.getByTitle("1 task(s)");
      expect(taskBadge).toBeInTheDocument();
    });

    it("does not render badges when all counts are zero", () => {
      const props = createStepNodeProps({
        taskCounts: { epic: 0, ticket: 0, task: 0 },
      });

      const { container } = render(<StepNode {...props} />);
      const taskCountDivs = container.querySelectorAll(".ml-auto.flex.gap-2");
      expect(taskCountDivs.length).toBe(0);
    });
  });

  describe("flash animation", () => {
    it("applies flash animation class when isFlashing is true", () => {
      const props = createStepNodeProps({
        isFlashing: true,
      });

      const { container } = render(<StepNode {...props} />);
      const button = container.querySelector("button");

      expect(button).toHaveClass("animate-flash-border");
    });

    it("does not apply flash animation class when isFlashing is false", () => {
      const props = createStepNodeProps({
        isFlashing: false,
      });

      const { container } = render(<StepNode {...props} />);
      const button = container.querySelector("button");

      expect(button).not.toHaveClass("animate-flash-border");
    });

    it("does not apply flash animation class when isFlashing is undefined", () => {
      const props = createStepNodeProps();

      const { container } = render(<StepNode {...props} />);
      const button = container.querySelector("button");

      expect(button).not.toHaveClass("animate-flash-border");
    });
  });

  describe("execution counts", () => {
    it("renders execution activity bar when there are active runs", () => {
      const props = createStepNodeProps({
        executionCounts: { active: 2, completed: 0, failed: 0 },
      });

      render(<StepNode {...props} />);

      expect(screen.getByText("Run")).toBeInTheDocument();
      expect(screen.getByTitle("2 active")).toBeInTheDocument();
    });

    it("renders execution activity bar with completed tasks", () => {
      const props = createStepNodeProps({
        executionCounts: { active: 0, completed: 3, failed: 0 },
      });

      render(<StepNode {...props} />);

      expect(screen.getByTitle("3 completed")).toBeInTheDocument();
    });

    it("renders execution activity bar with failed tasks", () => {
      const props = createStepNodeProps({
        executionCounts: { active: 0, completed: 0, failed: 1 },
      });

      render(<StepNode {...props} />);

      expect(screen.getByTitle("1 failed")).toBeInTheDocument();
    });

    it("renders all execution count types together", () => {
      const props = createStepNodeProps({
        executionCounts: { active: 1, completed: 2, failed: 1 },
      });

      render(<StepNode {...props} />);

      expect(screen.getByTitle("1 active")).toBeInTheDocument();
      expect(screen.getByTitle("2 completed")).toBeInTheDocument();
      expect(screen.getByTitle("1 failed")).toBeInTheDocument();
    });

    it("does not render execution bar when all counts are zero", () => {
      const props = createStepNodeProps({
        executionCounts: { active: 0, completed: 0, failed: 0 },
      });

      render(<StepNode {...props} />);

      expect(screen.queryByText("Run")).not.toBeInTheDocument();
    });

    it("does not render execution bar when executionCounts not provided", () => {
      const props = createStepNodeProps();

      render(<StepNode {...props} />);

      expect(screen.queryByText("Run")).not.toBeInTheDocument();
    });
  });
});
