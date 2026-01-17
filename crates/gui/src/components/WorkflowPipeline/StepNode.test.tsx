import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "../../test/test-utils";
import { StepNode, type StepNodeData } from "./StepNode";

// Helper to create step node props
function createStepNodeProps(overrides?: Partial<StepNodeData>) {
  const defaultData: StepNodeData = {
    step: {
      name: "Test Step",
      order: 0,
      agent_config: {
        model: "claude-3-sonnet",
        system_prompt: "",
        append_system_prompt: "",
        tools: [],
        allowed_tools: [],
        permission_mode: null,
      },
    },
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
        step: {
          name: "Review Step",
          order: 1,
          agent_config: {
            model: "claude-3-sonnet",
            system_prompt: "",
            append_system_prompt: "",
            tools: [],
            allowed_tools: [],
            permission_mode: null,
          },
        },
      });

      render(<StepNode {...props} />);

      expect(screen.getByText("Review Step")).toBeInTheDocument();
    });

    it("renders step order number (1-indexed)", () => {
      const props = createStepNodeProps({
        step: {
          name: "Test",
          order: 2,
          agent_config: {
            model: "",
            system_prompt: "",
            append_system_prompt: "",
            tools: [],
            allowed_tools: [],
            permission_mode: null,
          },
        },
      });

      render(<StepNode {...props} />);

      // Order is 0-indexed internally, displayed as 1-indexed
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("renders model name when provided", () => {
      const props = createStepNodeProps({
        step: {
          name: "Test",
          order: 0,
          agent_config: {
            model: "claude-3-opus",
            system_prompt: "",
            append_system_prompt: "",
            tools: [],
            allowed_tools: [],
            permission_mode: null,
          },
        },
      });

      render(<StepNode {...props} />);

      expect(screen.getByText("claude-3-opus")).toBeInTheDocument();
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
        step: {
          name: "Test",
          order: 0,
          agent_config: {
            model: "",
            system_prompt: "You are a helpful assistant",
            append_system_prompt: "",
            tools: [],
            allowed_tools: [],
            permission_mode: null,
          },
        },
      });

      render(<StepNode {...props} />);

      expect(screen.getByText("Prompt")).toBeInTheDocument();
    });

    it("shows Prompt badge when append_system_prompt is configured", () => {
      const props = createStepNodeProps({
        step: {
          name: "Test",
          order: 0,
          agent_config: {
            model: "",
            system_prompt: "",
            append_system_prompt: "Additional instructions",
            tools: [],
            allowed_tools: [],
            permission_mode: null,
          },
        },
      });

      render(<StepNode {...props} />);

      expect(screen.getByText("Prompt")).toBeInTheDocument();
    });

    it("shows tool count badge when tools are configured", () => {
      const props = createStepNodeProps({
        step: {
          name: "Test",
          order: 0,
          agent_config: {
            model: "",
            system_prompt: "",
            append_system_prompt: "",
            tools: ["tool1", "tool2"],
            allowed_tools: ["tool3"],
            permission_mode: null,
          },
        },
      });

      render(<StepNode {...props} />);

      // Total tools: 2 + 1 = 3
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("shows permission mode badge when set", () => {
      const props = createStepNodeProps({
        step: {
          name: "Test",
          order: 0,
          agent_config: {
            model: "",
            system_prompt: "",
            append_system_prompt: "",
            tools: [],
            allowed_tools: [],
            permission_mode: "auto",
          },
        },
      });

      render(<StepNode {...props} />);

      expect(screen.getByText("auto")).toBeInTheDocument();
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
});
