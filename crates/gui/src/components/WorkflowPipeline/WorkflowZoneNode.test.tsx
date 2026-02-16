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
    isCollapsed: false,
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
  describe("expanded view", () => {
    it("renders workflow name", () => {
      const props = createWorkflowZoneNodeProps({
        workflow: createWorkflow({ name: "Build Pipeline" }),
        isCollapsed: false,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      const heading = container.querySelector("button");
      expect(heading?.textContent).toContain("Build Pipeline");
    });

    it("renders step and task counts", () => {
      const props = createWorkflowZoneNodeProps({
        stepCount: 4,
        taskCount: 12,
        isCollapsed: false,
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
        isCollapsed: false,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      expect(container.textContent).toContain("Main build pipeline");
    });

    it("applies selected styling when workflow is selected", () => {
      const props = createWorkflowZoneNodeProps({
        isWorkflowSelected: true,
        isCollapsed: false,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      const button = container.querySelector("button");
      expect(button).toHaveClass("text-primary");
    });
  });

  describe("collapsed view", () => {
    it("renders compact card with workflow name", () => {
      const props = createWorkflowZoneNodeProps({
        workflow: createWorkflow({ name: "Deploy" }),
        isCollapsed: true,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      expect(container.textContent).toContain("Deploy");
    });

    it("renders step and task counts in collapsed view", () => {
      const props = createWorkflowZoneNodeProps({
        stepCount: 2,
        taskCount: 8,
        isCollapsed: true,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      expect(container.textContent).toContain("2 steps");
      expect(container.textContent).toContain("8 tasks");
    });

    it("applies selected ring in collapsed view", () => {
      const props = createWorkflowZoneNodeProps({
        isWorkflowSelected: true,
        isCollapsed: true,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      const card = container.firstChild;
      expect(card).toHaveClass("ring-2");
      expect(card).toHaveClass("ring-primary");
    });
  });

  describe("flash animation", () => {
    it("applies flash animation class when isFlashing is true in expanded view", () => {
      const props = createWorkflowZoneNodeProps({
        isFlashing: true,
        isCollapsed: false,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      const zone = container.querySelector(".relative.rounded-xl");
      expect(zone).toHaveClass("animate-flash-border");
    });

    it("does not apply flash animation class when isFlashing is false in expanded view", () => {
      const props = createWorkflowZoneNodeProps({
        isFlashing: false,
        isCollapsed: false,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      const zone = container.querySelector(".relative.rounded-xl");
      expect(zone).not.toHaveClass("animate-flash-border");
    });

    it("does not apply flash animation class when isFlashing is undefined in expanded view", () => {
      const props = createWorkflowZoneNodeProps({
        isCollapsed: false,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      const zone = container.querySelector(".relative.rounded-xl");
      expect(zone).not.toHaveClass("animate-flash-border");
    });
  });

  describe("click handler", () => {
    it("calls onWorkflowClick when workflow is clicked in expanded view", () => {
      const mockClick = vi.fn();
      const workflow = createWorkflow({ name: "Test" });

      const props = createWorkflowZoneNodeProps({
        workflow,
        onWorkflowClick: mockClick,
        isCollapsed: false,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      const button = container.querySelector("button");
      button?.click();

      expect(mockClick).toHaveBeenCalledWith(workflow);
    });

    it("calls onWorkflowClick when workflow is clicked in collapsed view", () => {
      const mockClick = vi.fn();
      const workflow = createWorkflow({ name: "Test" });

      const props = createWorkflowZoneNodeProps({
        workflow,
        onWorkflowClick: mockClick,
        isCollapsed: true,
      });

      const { container } = render(<WorkflowZoneNode {...props} />);

      const card = container.firstChild as HTMLElement;
      card?.click();

      expect(mockClick).toHaveBeenCalledWith(workflow);
    });
  });
});
