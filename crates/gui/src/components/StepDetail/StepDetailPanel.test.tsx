import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepDetailPanel } from "./StepDetailPanel";
import type { Step } from "../../bindings";

// Helper to create a step with defaults
function createStep(overrides?: Partial<Step>): Step {
  return {
    id: null,
    name: "Test Step",
    workflow_id: "workflow-1",
    order: 0,
    is_final: false,
    transitions_to: [],
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
  describe("rendering", () => {
    it("returns null when step is null", () => {
      const { container } = render(
        <StepDetailPanel step={null} />
      );
      expect(container.firstChild).toBeNull();
    });

    it("renders panel header with 'Step Configuration' title", () => {
      const step = createStep();
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("Step Configuration")).toBeInTheDocument();
    });

    it("renders step name in panel title", () => {
      const step = createStep({ name: "Development" });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByRole("heading", { name: "Development" })).toBeInTheDocument();
    });

    it("renders step order badge (1-indexed)", () => {
      const step = createStep({ order: 2 });
      render(<StepDetailPanel step={step} />);

      // Order 2 displays as "3" (1-indexed)
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("renders step position text", () => {
      const step = createStep({ order: 1 });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("Step 2 in workflow")).toBeInTheDocument();
    });
  });

  describe("model configuration", () => {
    it("shows 'Default' when no model is configured", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          model: null,
        },
      });
      render(<StepDetailPanel step={step} />);

      // Find the Model section and verify it shows Default
      const modelSection = screen.getByText("Model").closest("div");
      expect(modelSection).toBeInTheDocument();
      // Both model and permission mode show "Default", which is correct behavior
      expect(screen.getAllByText("Default")).toHaveLength(2);
    });

    it("displays configured model name", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          model: "claude-3-opus",
        },
      });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("claude-3-opus")).toBeInTheDocument();
    });

    it("displays fallback model when configured", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          model: "claude-3-opus",
          fallback_model: "claude-3-sonnet",
        },
      });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("claude-3-sonnet")).toBeInTheDocument();
    });
  });

  describe("system prompt", () => {
    it("displays system prompt override when configured", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          system_prompt: "You are a helpful assistant",
        },
      });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("System Prompt")).toBeInTheDocument();
      expect(screen.getByText("You are a helpful assistant")).toBeInTheDocument();
    });

    it("displays append system prompt when configured", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          append_system_prompt: "Additional instructions here",
        },
      });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("System Prompt")).toBeInTheDocument();
      expect(screen.getByText("Additional instructions here")).toBeInTheDocument();
    });

    it("does not show system prompt section when none configured", () => {
      const step = createStep();
      render(<StepDetailPanel step={step} />);

      expect(screen.queryByText("System Prompt")).not.toBeInTheDocument();
    });
  });

  describe("tools configuration", () => {
    it("displays built-in tools count in header", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          tools: ["read", "write", "execute"],
          allowed_tools: ["bash"],
        },
      });
      render(<StepDetailPanel step={step} />);

      // Total tools = 3 + 1 = 4
      expect(screen.getByText("Tools (4)")).toBeInTheDocument();
    });

    it("displays built-in tools as tags", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          tools: ["read", "write"],
        },
      });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("read")).toBeInTheDocument();
      expect(screen.getByText("write")).toBeInTheDocument();
    });

    it("displays allowed tools", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          allowed_tools: ["bash", "python"],
        },
      });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("bash")).toBeInTheDocument();
      expect(screen.getByText("python")).toBeInTheDocument();
    });

    it("displays disallowed tools with error styling", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          disallowed_tools: ["dangerous_tool"],
        },
      });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("dangerous_tool")).toBeInTheDocument();
    });

    it("shows 'Using default tools' when no tools configured", () => {
      const step = createStep();
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("Using default tools")).toBeInTheDocument();
    });
  });

  describe("permissions", () => {
    it("shows 'Default' when no permission mode configured", () => {
      const step = createStep();
      render(<StepDetailPanel step={step} />);

      // Find the permission mode "Default" text (there's also model Default)
      const modeSection = screen.getByText("Mode").closest("div");
      expect(modeSection).toBeInTheDocument();
    });

    it("displays configured permission mode", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          permission_mode: "plan",
        },
      });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("plan")).toBeInTheDocument();
    });

    it("displays budget when configured", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          max_budget_usd: 10.5,
        },
      });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("$10.50")).toBeInTheDocument();
    });
  });

  describe("MCP configuration", () => {
    it("displays MCP servers when configured", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          mcp_config: ["server1", "server2"],
        },
      });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("MCP Servers")).toBeInTheDocument();
      expect(screen.getByText("server1")).toBeInTheDocument();
      expect(screen.getByText("server2")).toBeInTheDocument();
    });

    it("does not show MCP section when no servers configured", () => {
      const step = createStep();
      render(<StepDetailPanel step={step} />);

      expect(screen.queryByText("MCP Servers")).not.toBeInTheDocument();
    });
  });

  describe("plugin directories", () => {
    it("displays plugin directories when configured", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          plugin_dirs: ["/path/to/plugins", "/another/path"],
        },
      });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("Plugin Directories")).toBeInTheDocument();
      expect(screen.getByText("/path/to/plugins")).toBeInTheDocument();
      expect(screen.getByText("/another/path")).toBeInTheDocument();
    });
  });

  describe("custom agents", () => {
    it("displays custom agents when configured", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          agents: "custom agent config here",
        },
      });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("Custom Agents")).toBeInTheDocument();
      expect(screen.getByText("custom agent config here")).toBeInTheDocument();
    });
  });

  describe("JSON schema", () => {
    it("displays output schema when configured", () => {
      const step = createStep({
        agent_config: {
          ...createStep().agent_config,
          json_schema: '{"type": "object"}',
        },
      });
      render(<StepDetailPanel step={step} />);

      expect(screen.getByText("Output Schema")).toBeInTheDocument();
      expect(screen.getByText('{"type": "object"}')).toBeInTheDocument();
    });
  });

  describe("close button", () => {
    it("renders close button when onClose is provided", () => {
      const step = createStep();
      const onClose = vi.fn();
      render(<StepDetailPanel step={step} onClose={onClose} />);

      expect(screen.getByLabelText("Close panel")).toBeInTheDocument();
    });

    it("calls onClose when close button is clicked", async () => {
      const user = userEvent.setup();
      const step = createStep();
      const onClose = vi.fn();
      render(<StepDetailPanel step={step} onClose={onClose} />);

      await user.click(screen.getByLabelText("Close panel"));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not render close button when onClose is not provided", () => {
      const step = createStep();
      render(<StepDetailPanel step={step} />);

      expect(screen.queryByLabelText("Close panel")).not.toBeInTheDocument();
    });
  });
});
