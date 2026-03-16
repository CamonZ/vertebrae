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

  describe("upsertTask", () => {
    it("adds a new task when it does not exist in the list", () => {
      const task = createMockTask({ id: "task-new", title: "New Task" });

      useTaskStore.getState().upsertTask(task);

      const state = useTaskStore.getState();
      expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0].id).toBe("task-new");
      expect(state.tasks[0].title).toBe("New Task");
    });

    it("updates an existing task in the list", () => {
      const original = createMockTask({ id: "task-1", title: "Original" });
      useTaskStore.getState().setTasks([original]);

      const updated = createMockTask({ id: "task-1", title: "Updated" });
      useTaskStore.getState().upsertTask(updated);

      const state = useTaskStore.getState();
      expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0].title).toBe("Updated");
    });

    it("preserves existing sections when WS payload has empty sections", () => {
      const sections = [{ type: "checklist_item" as const, content: "Do thing", order: 1, done: false, done_at: null }];
      const original = createMockTask({ id: "task-1", title: "Task", sections });
      useTaskStore.getState().setTasks([original]);

      const wsPayload = createMockTask({ id: "task-1", title: "Task Updated", sections: [] });
      useTaskStore.getState().upsertTask(wsPayload);

      const state = useTaskStore.getState();
      expect(state.tasks[0].title).toBe("Task Updated");
      expect(state.tasks[0].sections).toEqual(sections);
    });

    it("replaces sections when WS payload has non-empty sections", () => {
      const oldSections = [{ type: "checklist_item" as const, content: "Old", order: 1, done: false, done_at: null }];
      const newSections = [{ type: "constraint" as const, content: "New", order: 1, done: null, done_at: null }];
      const original = createMockTask({ id: "task-1", sections: oldSections });
      useTaskStore.getState().setTasks([original]);

      const wsPayload = createMockTask({ id: "task-1", sections: newSections });
      useTaskStore.getState().upsertTask(wsPayload);

      expect(useTaskStore.getState().tasks[0].sections).toEqual(newSections);
    });

    it("preserves existing code_refs when WS payload has empty code_refs", () => {
      const codeRefs = [{ path: "src/main.rs", line_start: 1, line_end: 10, name: null, description: null }];
      const original = createMockTask({ id: "task-1", code_refs: codeRefs });
      useTaskStore.getState().setTasks([original]);

      const wsPayload = createMockTask({ id: "task-1", title: "Updated", code_refs: [] });
      useTaskStore.getState().upsertTask(wsPayload);

      expect(useTaskStore.getState().tasks[0].code_refs).toEqual(codeRefs);
    });

    it("updates selectedTask when the upserted task matches selectedTaskId", () => {
      const task = createMockTask({ id: "task-1", title: "Original" });
      useTaskStore.getState().setTasks([task]);
      useTaskStore.getState().selectTask("task-1", task);

      const updated = createMockTask({ id: "task-1", title: "Updated via WS" });
      useTaskStore.getState().upsertTask(updated);

      const state = useTaskStore.getState();
      expect(state.selectedTask?.title).toBe("Updated via WS");
    });

    it("does not update selectedTask when the upserted task is different from selected", () => {
      const task1 = createMockTask({ id: "task-1", title: "Task 1" });
      const task2 = createMockTask({ id: "task-2", title: "Task 2" });
      useTaskStore.getState().setTasks([task1, task2]);
      useTaskStore.getState().selectTask("task-1", task1);

      const updatedTask2 = createMockTask({ id: "task-2", title: "Task 2 Updated" });
      useTaskStore.getState().upsertTask(updatedTask2);

      const state = useTaskStore.getState();
      expect(state.selectedTask?.title).toBe("Task 1");
      expect(state.tasks[1].title).toBe("Task 2 Updated");
    });

    it("does not change the order of other tasks in the list", () => {
      const tasks = [
        createMockTask({ id: "task-1", title: "First" }),
        createMockTask({ id: "task-2", title: "Second" }),
        createMockTask({ id: "task-3", title: "Third" }),
      ];
      useTaskStore.getState().setTasks(tasks);

      useTaskStore.getState().upsertTask(createMockTask({ id: "task-2", title: "Second Updated" }));

      const state = useTaskStore.getState();
      expect(state.tasks[0].id).toBe("task-1");
      expect(state.tasks[1].id).toBe("task-2");
      expect(state.tasks[1].title).toBe("Second Updated");
      expect(state.tasks[2].id).toBe("task-3");
    });
  });

  describe("removeTask", () => {
    it("removes a task from the list by ID", () => {
      const tasks = [
        createMockTask({ id: "task-1", title: "Task 1" }),
        createMockTask({ id: "task-2", title: "Task 2" }),
      ];
      useTaskStore.getState().setTasks(tasks);

      useTaskStore.getState().removeTask("task-1");

      const state = useTaskStore.getState();
      expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0].id).toBe("task-2");
    });

    it("clears selection when the removed task is the selected task", () => {
      const task = createMockTask({ id: "task-1", title: "Task 1" });
      useTaskStore.getState().setTasks([task]);
      useTaskStore.getState().selectTask("task-1", task);

      useTaskStore.getState().removeTask("task-1");

      const state = useTaskStore.getState();
      expect(state.tasks).toHaveLength(0);
      expect(state.selectedTaskId).toBeNull();
      expect(state.selectedTask).toBeNull();
    });

    it("does not clear selection when a different task is removed", () => {
      const task1 = createMockTask({ id: "task-1", title: "Task 1" });
      const task2 = createMockTask({ id: "task-2", title: "Task 2" });
      useTaskStore.getState().setTasks([task1, task2]);
      useTaskStore.getState().selectTask("task-1", task1);

      useTaskStore.getState().removeTask("task-2");

      const state = useTaskStore.getState();
      expect(state.tasks).toHaveLength(1);
      expect(state.selectedTaskId).toBe("task-1");
      expect(state.selectedTask?.title).toBe("Task 1");
    });

    it("is a no-op when the task ID does not exist", () => {
      const task = createMockTask({ id: "task-1", title: "Task 1" });
      useTaskStore.getState().setTasks([task]);

      useTaskStore.getState().removeTask("nonexistent");

      expect(useTaskStore.getState().tasks).toHaveLength(1);
    });
  });
});
