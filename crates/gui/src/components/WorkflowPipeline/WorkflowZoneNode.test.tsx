import { describe, it, expect, vi } from "vitest";
import { render } from "../../test/test-utils";
import { WorkflowZoneNode, type WorkflowZoneNodeData } from "./WorkflowZoneNode";
import type { Workflow } from "../../bindings";

/**
 * Create a complete Workflow with defaults
 */
function createWorkflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: "workflow-1",
    name: "Test Workflow",
    description: "A test workflow",
    initial_step: null,
    kanban_column: null,
    is_default: false,
    metadata: {},
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

/**
 * Helper to create workflow zone node props
 */
function createWorkflowZoneNodeProps(overrides?: Partial<WorkflowZoneNodeData>) {
  const defaultData: WorkflowZoneNodeData = {
    workflow: createWorkflow(),
    taskCount: 5,
    stepCount: 3,
    width: 800,
    height: 400,
    onWorkflowClick: vi.fn(),
    isWorkflowSelected: false,
    ...overrides,
  };

  return {
    id: "workflow-zone-1",
    type: "workflowZoneNode" as const,
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

describe("WorkflowZoneNode", () => {
  describe("workflow zone", () => {
    it("renders workflow name", () => {
      const props = createWorkflowZoneNodeProps({
        workflow: createWorkflow({ name: "Build Pipeline" }),
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      const heading = container.querySelector("button");
      expect(heading?.textContent).toContain("Build Pipeline");
    });

    it("renders step and task counts", () => {
      const props = createWorkflowZoneNodeProps({
        stepCount: 4,
        taskCount: 12,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      expect(container.textContent).toContain("4 steps");
      expect(container.textContent).toContain("12 tasks");
    });

    it("renders workflow description when provided", () => {
      const props = createWorkflowZoneNodeProps({
        workflow: createWorkflow({
          name: "Build",
          description: "Main build pipeline",
        }),
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      expect(container.textContent).toContain("Main build pipeline");
    });

    it("applies selected styling when workflow is selected", () => {
      const props = createWorkflowZoneNodeProps({
        isWorkflowSelected: true,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      const button = container.querySelector("button");
      expect(button).toHaveClass("text-primary");
    });
  });

  describe("is_default badge", () => {
    it("renders 'Default' badge when is_default is true", () => {
      const props = createWorkflowZoneNodeProps({
        workflow: createWorkflow({ is_default: true }),
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      expect(container.textContent).toContain("Default");
    });

    it("does not render 'Default' badge when is_default is false", () => {
      const props = createWorkflowZoneNodeProps({
        workflow: createWorkflow({ is_default: false }),
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      expect(container.textContent).not.toContain("Default");
    });

  });

  describe("kanban_column display", () => {
    it("renders kanban_column when set", () => {
      const props = createWorkflowZoneNodeProps({
        workflow: createWorkflow({ kanban_column: "in_progress" }),
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      expect(container.textContent).toContain("in_progress");
    });

    it("does not render kanban_column when null", () => {
      const props = createWorkflowZoneNodeProps({
        workflow: createWorkflow({ kanban_column: null }),
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      expect(container.textContent).not.toContain("in_progress");
    });

  });

  describe("flash animation", () => {
    it("applies flash animation class when isFlashing is true", () => {
      const props = createWorkflowZoneNodeProps({
        isFlashing: true,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      const zone = container.querySelector(".relative.rounded-xl");
      expect(zone).toHaveClass("animate-flash-border");
    });

    it("does not apply flash animation class when isFlashing is false", () => {
      const props = createWorkflowZoneNodeProps({
        isFlashing: false,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      const zone = container.querySelector(".relative.rounded-xl");
      expect(zone).not.toHaveClass("animate-flash-border");
    });

    it("does not apply flash animation class when isFlashing is undefined", () => {
      const props = createWorkflowZoneNodeProps();

      const { container } = render(<WorkflowZoneNode {...props} />);

      const zone = container.querySelector(".relative.rounded-xl");
      expect(zone).not.toHaveClass("animate-flash-border");
    });
  });

  describe("click handler", () => {
    it("calls onWorkflowClick when workflow is clicked", () => {
      const mockClick = vi.fn();
      const workflow = createWorkflow({ name: "Test" });

      const props = createWorkflowZoneNodeProps({
        workflow,
        onWorkflowClick: mockClick,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      const button = container.querySelector("button");
      button?.click();

      expect(mockClick).toHaveBeenCalledWith(workflow);
    });

  });
});
