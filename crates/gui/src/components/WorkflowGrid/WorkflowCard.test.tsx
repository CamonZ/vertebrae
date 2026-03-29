import { describe, it, expect } from "vitest";
import { render, screen } from "../../test/test-utils";
import { WorkflowCard } from "./WorkflowCard";
import type { Workflow } from "../../bindings";

function createWorkflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: "workflow-abc123",
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

describe("WorkflowCard", () => {
  describe("basic rendering", () => {
    it("renders workflow name", () => {
      const workflow = createWorkflow({ name: "Build Pipeline" });
      render(<WorkflowCard workflow={workflow} />);

      expect(
        screen.getByRole("heading", { name: "Build Pipeline" })
      ).toBeInTheDocument();
    });

    it("renders truncated workflow ID (first 6 chars)", () => {
      const workflow = createWorkflow({ id: "workflow-abc123" });
      render(<WorkflowCard workflow={workflow} />);

      expect(screen.getByText("workfl")).toBeInTheDocument();
    });

    it("renders description when provided", () => {
      const workflow = createWorkflow({
        description: "Handles CI/CD tasks",
      });
      render(<WorkflowCard workflow={workflow} />);

      expect(screen.getByText("Handles CI/CD tasks")).toBeInTheDocument();
    });

    it("does not render description when null", () => {
      const workflow = createWorkflow({ description: null });
      render(<WorkflowCard workflow={workflow} />);

      expect(
        screen.queryByText("Handles CI/CD tasks")
      ).not.toBeInTheDocument();
    });

    it("shows 'Active' when initial_step is set", () => {
      const workflow = createWorkflow({ initial_step: "step-1" });
      render(<WorkflowCard workflow={workflow} />);

      expect(screen.getByText("Active")).toBeInTheDocument();
    });

    it("shows 'No steps configured' when initial_step is null", () => {
      const workflow = createWorkflow({ initial_step: null });
      render(<WorkflowCard workflow={workflow} />);

      expect(screen.getByText("No steps configured")).toBeInTheDocument();
    });

    it("links to the workflow detail page", () => {
      const workflow = createWorkflow({ id: "wf-123" });
      render(<WorkflowCard workflow={workflow} />);

      const link = screen.getByRole("link", {
        name: "View workflow: Test Workflow",
      });
      expect(link).toHaveAttribute("href", "/workflow/wf-123");
    });
  });

  describe("is_default badge", () => {
    it("renders 'Default' badge when is_default is true", () => {
      const workflow = createWorkflow({ is_default: true });
      render(<WorkflowCard workflow={workflow} />);

      expect(screen.getByText("Default")).toBeInTheDocument();
    });

    it("does not render 'Default' badge when is_default is false", () => {
      const workflow = createWorkflow({ is_default: false });
      render(<WorkflowCard workflow={workflow} />);

      expect(screen.queryByText("Default")).not.toBeInTheDocument();
    });

    it("does not render 'Default' badge when is_default is undefined", () => {
      const workflow = createWorkflow();
      render(<WorkflowCard workflow={workflow} />);

      expect(screen.queryByText("Default")).not.toBeInTheDocument();
    });
  });

  describe("kanban_column display", () => {
    it("renders kanban column when set", () => {
      const workflow = createWorkflow({ kanban_column: "in_progress" });
      render(<WorkflowCard workflow={workflow} />);

      expect(screen.getByText("in_progress")).toBeInTheDocument();
    });

    it("does not render kanban column when null", () => {
      const workflow = createWorkflow({ kanban_column: null });
      render(<WorkflowCard workflow={workflow} />);

      expect(screen.queryByText("in_progress")).not.toBeInTheDocument();
    });

    it("renders kanban column alongside active status", () => {
      const workflow = createWorkflow({
        initial_step: "step-1",
        kanban_column: "review",
      });
      render(<WorkflowCard workflow={workflow} />);

      expect(screen.getByText("Active")).toBeInTheDocument();
      expect(screen.getByText("review")).toBeInTheDocument();
    });
  });
});
