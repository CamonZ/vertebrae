import { describe, it, expect, beforeEach } from "vitest";
import { useTaskStore } from "./taskStore";
import { createMockTask } from "../test/test-utils";

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
        createMockTask({ id: "task-1", title: "Task 1", step_name: "backlog" }),
        createMockTask({ id: "task-2", title: "Task 2", step_name: "done" }),
      ];

      useTaskStore.getState().setTasks(tasks);

      expect(useTaskStore.getState().tasks).toEqual(tasks);
    });

    it("replaces existing tasks", () => {
      const initialTasks = [
        createMockTask({ id: "task-1", title: "Task 1", step_name: "backlog" }),
      ];
      const newTasks = [
        createMockTask({ id: "task-2", title: "Task 2", step_name: "done" }),
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
      const task = createMockTask({ id: "task-123", title: "Selected Task" });

      useTaskStore.getState().selectTask("task-123", task);

      expect(useTaskStore.getState().selectedTaskId).toBe("task-123");
      expect(useTaskStore.getState().selectedTask).toEqual(task);
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
      const task = createMockTask();
      useTaskStore.getState().selectTask("task-123", task);

      useTaskStore.getState().clearSelection();

      expect(useTaskStore.getState().selectedTaskId).toBeNull();
      expect(useTaskStore.getState().selectedTask).toBeNull();
    });
  });
});
