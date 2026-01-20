import { describe, it, expect, beforeEach } from "vitest";
import { useTaskStore } from "./taskStore";
import { createMockTaskWithRelations, createMockTaskSummary } from "../test/test-utils";

describe("taskStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      selectedTask: null,
      isLoading: false,
    });
  });

  describe("initial state", () => {
    it("has empty tasks array", () => {
      const state = useTaskStore.getState();
      expect(state.tasks).toEqual([]);
    });

    it("has no selected task", () => {
      const state = useTaskStore.getState();
      expect(state.selectedTaskId).toBeNull();
      expect(state.selectedTask).toBeNull();
    });

    it("is not loading", () => {
      const state = useTaskStore.getState();
      expect(state.isLoading).toBe(false);
    });
  });

  describe("setTasks", () => {
    it("updates the tasks array", () => {
      const tasks = [
        createMockTaskSummary({ id: "task-1", title: "Task 1", status: "backlog" }),
        createMockTaskSummary({ id: "task-2", title: "Task 2", status: "done" }),
      ];

      useTaskStore.getState().setTasks(tasks);

      expect(useTaskStore.getState().tasks).toEqual(tasks);
    });

    it("replaces existing tasks", () => {
      const initialTasks = [
        createMockTaskSummary({ id: "task-1", title: "Task 1", status: "backlog" }),
      ];
      const newTasks = [
        createMockTaskSummary({ id: "task-2", title: "Task 2", status: "done" }),
      ];

      useTaskStore.getState().setTasks(initialTasks);
      useTaskStore.getState().setTasks(newTasks);

      expect(useTaskStore.getState().tasks).toEqual(newTasks);
    });
  });

  describe("selectTask", () => {
    it("sets the selected task ID", () => {
      useTaskStore.getState().selectTask("task-123");

      expect(useTaskStore.getState().selectedTaskId).toBe("task-123");
    });

    it("sets the selected task details when provided", () => {
      const taskWithRelations = createMockTaskWithRelations({
        task: { id: "task-123", title: "Selected Task" },
      });

      useTaskStore.getState().selectTask("task-123", taskWithRelations);

      expect(useTaskStore.getState().selectedTaskId).toBe("task-123");
      expect(useTaskStore.getState().selectedTask).toEqual(taskWithRelations);
    });

    it("clears selection when null is passed", () => {
      // First select a task
      useTaskStore.getState().selectTask("task-123");

      // Then deselect
      useTaskStore.getState().selectTask(null);

      expect(useTaskStore.getState().selectedTaskId).toBeNull();
      expect(useTaskStore.getState().selectedTask).toBeNull();
    });
  });

  describe("setLoading", () => {
    it("sets loading to true", () => {
      useTaskStore.getState().setLoading(true);

      expect(useTaskStore.getState().isLoading).toBe(true);
    });

    it("sets loading to false", () => {
      useTaskStore.getState().setLoading(true);
      useTaskStore.getState().setLoading(false);

      expect(useTaskStore.getState().isLoading).toBe(false);
    });
  });

  describe("clearSelection", () => {
    it("clears both selectedTaskId and selectedTask", () => {
      const taskWithRelations = createMockTaskWithRelations();
      useTaskStore.getState().selectTask("task-123", taskWithRelations);

      useTaskStore.getState().clearSelection();

      expect(useTaskStore.getState().selectedTaskId).toBeNull();
      expect(useTaskStore.getState().selectedTask).toBeNull();
    });
  });
});
