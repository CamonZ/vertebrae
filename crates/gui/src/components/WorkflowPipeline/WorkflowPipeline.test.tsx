import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  render,
  createMockWorkflow,
  createMockTaskWithRelations,
} from "../../test/test-utils";
import { WorkflowPipeline } from "./WorkflowPipeline";

describe("WorkflowPipeline", () => {
  describe("rendering", () => {
    it("renders empty state when no steps are defined", () => {
      const workflow = createMockWorkflow({ steps: [] });
      render(<WorkflowPipeline workflow={workflow} />);

      expect(screen.getByText("No steps defined")).toBeInTheDocument();
      expect(
        screen.getByText("Add steps to this workflow to create a pipeline")
      ).toBeInTheDocument();
    });

    it("renders step nodes for each workflow step", () => {
      const workflow = createMockWorkflow();
      render(<WorkflowPipeline workflow={workflow} />);

      // Check that step names are rendered (both in step nodes and zone labels)
      expect(screen.getAllByText(/backlog/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/in_progress/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/done/i).length).toBeGreaterThan(0);
    });

    it("renders tasks in their corresponding zones", () => {
      const workflow = createMockWorkflow();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Task in Backlog", status: "backlog" },
        }),
        createMockTaskWithRelations({
          task: { id: "task-2", title: "Task Done", status: "done" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} tasksWithRelations={tasks} />
      );

      // Tasks are rendered inside zones (React Flow may render nodes multiple times)
      expect(screen.getAllByText("Task in Backlog").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Task Done").length).toBeGreaterThan(0);
      // Verify zone counts show the tasks
      expect(screen.getByText(/backlog \(1\)/i)).toBeInTheDocument();
      expect(screen.getByText(/done \(1\)/i)).toBeInTheDocument();
    });

    it("shows task count in zone labels", () => {
      const workflow = createMockWorkflow();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Task 1", status: "backlog" },
        }),
        createMockTaskWithRelations({
          task: { id: "task-2", title: "Task 2", status: "backlog" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} tasksWithRelations={tasks} />
      );

      // Zone should show count
      expect(screen.getByText(/backlog \(2\)/i)).toBeInTheDocument();
    });
  });

  describe("task grouping", () => {
    it("groups done/rejected tasks into done zone", () => {
      const workflow = createMockWorkflow();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Done Task", status: "done" },
        }),
        createMockTaskWithRelations({
          task: { id: "task-2", title: "Rejected Task", status: "rejected" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} tasksWithRelations={tasks} />
      );

      // Both should appear in done zone - check the zone label shows count
      expect(screen.getByText(/done \(2\)/i)).toBeInTheDocument();
    });

    it("places tasks without execution state in first step", () => {
      const workflow = createMockWorkflow();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "New Task", status: "todo" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} tasksWithRelations={tasks} />
      );

      // Task without execution state should be in backlog (first step)
      expect(screen.getByText(/backlog \(1\)/i)).toBeInTheDocument();
    });

    it("places tasks based on execution state currentStep", () => {
      const workflow = createMockWorkflow();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "In Progress Task", status: "todo" },
        }),
      ];

      const executionState = new Map([
        ["task-1", { currentStep: "in_progress", status: "in_progress" }],
      ]);

      render(
        <WorkflowPipeline
          workflow={workflow}
          tasksWithRelations={tasks}
          executionState={executionState}
        />
      );

      // Task should be in in_progress zone
      expect(screen.getByText(/in_progress \(1\)/i)).toBeInTheDocument();
    });
  });

  describe("step node rendering", () => {
    it("marks first step as Entry", () => {
      const workflow = createMockWorkflow();
      render(<WorkflowPipeline workflow={workflow} />);

      expect(screen.getByText("Entry")).toBeInTheDocument();
    });

    it("marks last step as Exit", () => {
      const workflow = createMockWorkflow();
      render(<WorkflowPipeline workflow={workflow} />);

      expect(screen.getByText("Exit")).toBeInTheDocument();
    });

    it("marks middle steps as Process", () => {
      const workflow = createMockWorkflow();
      render(<WorkflowPipeline workflow={workflow} />);

      expect(screen.getByText("Process")).toBeInTheDocument();
    });
  });

  describe("execution state", () => {
    it("shows waiting status icon for tasks without execution state", () => {
      const workflow = createMockWorkflow();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Waiting Task", status: "backlog" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} tasksWithRelations={tasks} />
      );

      // The waiting icon is ○
      expect(screen.getByText("○")).toBeInTheDocument();
    });

    it("shows in_progress status icon for executing tasks", () => {
      const workflow = createMockWorkflow();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Running Task", status: "backlog" },
        }),
      ];

      const executionState = new Map([
        ["task-1", { currentStep: "backlog", status: "in_progress" }],
      ]);

      render(
        <WorkflowPipeline
          workflow={workflow}
          tasksWithRelations={tasks}
          executionState={executionState}
        />
      );

      // The in_progress icon is ⟳ - tasks are rendered in zones now
      expect(screen.getAllByText("⟳").length).toBeGreaterThan(0);
    });

    it("shows completed status icon for done tasks", () => {
      const workflow = createMockWorkflow();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Completed Task", status: "done" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} tasksWithRelations={tasks} />
      );

      // The done icon is ✓
      expect(screen.getByText("✓")).toBeInTheDocument();
    });
  });

  describe("callbacks", () => {
    it("passes onPlayClick to step nodes", () => {
      const onPlayClick = vi.fn();
      const workflow = createMockWorkflow();

      render(
        <WorkflowPipeline workflow={workflow} onPlayClick={onPlayClick} />
      );

      // Component should render without error when callback is provided
      expect(screen.getAllByText(/backlog/i).length).toBeGreaterThan(0);
    });
  });

  describe("empty zones", () => {
    it("shows 'No tasks' message for empty zones", () => {
      const workflow = createMockWorkflow();

      render(<WorkflowPipeline workflow={workflow} tasksWithRelations={[]} />);

      // All zones should show "No tasks"
      const noTasksElements = screen.getAllByText("No tasks");
      expect(noTasksElements.length).toBe(3); // One for each step zone
    });
  });
});
