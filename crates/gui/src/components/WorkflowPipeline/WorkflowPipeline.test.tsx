import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  render,
  createMockWorkflow,
  createMockSteps,
  createMockTaskWithRelations,
} from "../../test/test-utils";
import { WorkflowPipeline } from "./WorkflowPipeline";

describe("WorkflowPipeline", () => {
  describe("rendering", () => {
    it("renders empty state when no steps are defined", () => {
      const workflow = createMockWorkflow();
      render(<WorkflowPipeline workflow={workflow} steps={[]} />);

      expect(screen.getByText("No steps defined")).toBeInTheDocument();
      expect(
        screen.getByText("Add steps to this workflow to create a pipeline")
      ).toBeInTheDocument();
    });

    it("renders step nodes for each workflow step", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      render(<WorkflowPipeline workflow={workflow} steps={steps} />);

      // Check that step names are rendered (both in step nodes and zone labels)
      expect(screen.getAllByText(/backlog/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/in_progress/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/done/i).length).toBeGreaterThan(0);
    });

    it("renders tasks in their corresponding zones", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Task in Backlog", status: "backlog" },
        }),
        createMockTaskWithRelations({
          task: { id: "task-2", title: "Task Done", status: "done" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} steps={steps} tasksWithRelations={tasks} />
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
      const steps = createMockSteps();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Task 1", status: "backlog" },
        }),
        createMockTaskWithRelations({
          task: { id: "task-2", title: "Task 2", status: "backlog" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} steps={steps} tasksWithRelations={tasks} />
      );

      // Zone should show count
      expect(screen.getByText(/backlog \(2\)/i)).toBeInTheDocument();
    });
  });

  describe("task grouping", () => {
    it("groups done/rejected tasks into done zone", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Done Task", status: "done" },
        }),
        createMockTaskWithRelations({
          task: { id: "task-2", title: "Rejected Task", status: "rejected" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} steps={steps} tasksWithRelations={tasks} />
      );

      // Both should appear in done zone - check the zone label shows count
      expect(screen.getByText(/done \(2\)/i)).toBeInTheDocument();
    });

    it("places tasks without current_step_id in first step", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "New Task", status: "todo" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} steps={steps} tasksWithRelations={tasks} />
      );

      // Task without current_step_id should be in backlog (first step)
      expect(screen.getByText(/backlog \(1\)/i)).toBeInTheDocument();
    });

    it("places tasks based on current_step_id when stepIdToName is provided", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      const tasks = [
        createMockTaskWithRelations({
          task: {
            id: "task-1",
            title: "Task with Step ID",
            status: "todo",
            current_step_id: "step-in-progress-123",
          },
        }),
      ];

      // Map step ID to step name
      const stepIdToName = new Map([
        ["step-in-progress-123", "in_progress"],
      ]);

      render(
        <WorkflowPipeline
          workflow={workflow}
          steps={steps}
          tasksWithRelations={tasks}
          stepIdToName={stepIdToName}
        />
      );

      // Task should be in in_progress zone based on current_step_id
      expect(screen.getByText(/in_progress \(1\)/i)).toBeInTheDocument();
    });

    it("uses execution state for positioning during workflow execution", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Executing Task", status: "todo" },
        }),
      ];

      const executionState = new Map([
        ["task-1", { currentStep: "in_progress", status: "in_progress" }],
      ]);

      render(
        <WorkflowPipeline
          workflow={workflow}
          steps={steps}
          tasksWithRelations={tasks}
          executionState={executionState}
        />
      );

      // Task should be in in_progress zone based on execution state
      expect(screen.getByText(/in_progress \(1\)/i)).toBeInTheDocument();
    });

    it("prioritizes current_step_id over execution state for positioning", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      const tasks = [
        createMockTaskWithRelations({
          task: {
            id: "task-1",
            title: "Task with Both",
            status: "todo",
            current_step_id: "step-done-456",
          },
        }),
      ];

      // Step ID maps to "done" step
      const stepIdToName = new Map([
        ["step-done-456", "done"],
      ]);

      // Execution state says "backlog" but current_step_id says "done"
      const executionState = new Map([
        ["task-1", { currentStep: "backlog", status: "in_progress" }],
      ]);

      render(
        <WorkflowPipeline
          workflow={workflow}
          steps={steps}
          tasksWithRelations={tasks}
          stepIdToName={stepIdToName}
          executionState={executionState}
        />
      );

      // Task should be in done zone (current_step_id takes priority)
      expect(screen.getByText(/done \(1\)/i)).toBeInTheDocument();
    });
  });

  describe("step node rendering", () => {
    it("marks first step as Entry", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      render(<WorkflowPipeline workflow={workflow} steps={steps} />);

      expect(screen.getByText("Entry")).toBeInTheDocument();
    });

    it("marks last step as Exit", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      render(<WorkflowPipeline workflow={workflow} steps={steps} />);

      expect(screen.getByText("Exit")).toBeInTheDocument();
    });

    it("marks middle steps as Process", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      render(<WorkflowPipeline workflow={workflow} steps={steps} />);

      expect(screen.getByText("Process")).toBeInTheDocument();
    });
  });

  describe("status visual styling", () => {
    it("shows backlog status icon for backlog tasks", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Backlog Task", status: "backlog" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} steps={steps} tasksWithRelations={tasks} />
      );

      // The backlog icon is ○
      expect(screen.getByText("○")).toBeInTheDocument();
    });

    it("shows todo status icon for todo tasks", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Todo Task", status: "todo" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} steps={steps} tasksWithRelations={tasks} />
      );

      // The todo icon is ◉
      expect(screen.getByText("◉")).toBeInTheDocument();
    });

    it("shows in_progress status icon for in_progress tasks", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Running Task", status: "in_progress" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} steps={steps} tasksWithRelations={tasks} />
      );

      // The in_progress icon is ⟳ (spinning)
      expect(screen.getAllByText("⟳").length).toBeGreaterThan(0);
    });

    it("shows pending_review status icon for pending_review tasks", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Review Task", status: "pending_review" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} steps={steps} tasksWithRelations={tasks} />
      );

      // The pending_review icon is ◈
      expect(screen.getByText("◈")).toBeInTheDocument();
    });

    it("shows done status icon for done tasks", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Completed Task", status: "done" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} steps={steps} tasksWithRelations={tasks} />
      );

      // The done icon is ✓
      expect(screen.getByText("✓")).toBeInTheDocument();
    });

    it("shows rejected status icon for rejected tasks", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Rejected Task", status: "rejected" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} steps={steps} tasksWithRelations={tasks} />
      );

      // The rejected icon is ✕
      expect(screen.getByText("✕")).toBeInTheDocument();
    });

    it("displays status visually independent of position", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();
      // Task has in_progress status but is positioned in backlog step
      const tasks = [
        createMockTaskWithRelations({
          task: { id: "task-1", title: "Mixed State Task", status: "in_progress" },
        }),
      ];

      render(
        <WorkflowPipeline workflow={workflow} steps={steps} tasksWithRelations={tasks} />
      );

      // Task should be in backlog zone (first step, no current_step_id)
      expect(screen.getByText(/backlog \(1\)/i)).toBeInTheDocument();
      // But should show in_progress icon (spinning ⟳)
      expect(screen.getAllByText("⟳").length).toBeGreaterThan(0);
    });
  });

  describe("callbacks", () => {
    it("passes onPlayClick to step nodes", () => {
      const onPlayClick = vi.fn();
      const workflow = createMockWorkflow();
      const steps = createMockSteps();

      render(
        <WorkflowPipeline workflow={workflow} steps={steps} onPlayClick={onPlayClick} />
      );

      // Component should render without error when callback is provided
      expect(screen.getAllByText(/backlog/i).length).toBeGreaterThan(0);
    });
  });

  describe("empty zones", () => {
    it("shows 'No tasks' message for empty zones", () => {
      const workflow = createMockWorkflow();
      const steps = createMockSteps();

      render(<WorkflowPipeline workflow={workflow} steps={steps} tasksWithRelations={[]} />);

      // All zones should show "No tasks"
      const noTasksElements = screen.getAllByText("No tasks");
      expect(noTasksElements.length).toBe(3); // One for each step zone
    });
  });
});
