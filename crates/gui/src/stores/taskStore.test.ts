import { describe, it, expect, beforeEach } from "vitest";
import { useTaskStore } from "./taskStore";
import {
  createMockTask,
  createMockTaskRun,
  createMockTaskRunControls,
} from "../test/test-utils";

describe("taskStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useTaskStore.setState({
      tasks: [],
      activeFilter: null,
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
      const sections = [
        {
          type: "checklist_item" as const,
          content: "Do thing",
          order: 1,
          done: false,
          done_at: null,
        },
      ];
      const original = createMockTask({
        id: "task-1",
        title: "Task",
        sections,
      });
      useTaskStore.getState().setTasks([original]);

      const wsPayload = createMockTask({
        id: "task-1",
        title: "Task Updated",
        sections: [],
      });
      useTaskStore.getState().upsertTask(wsPayload);

      const state = useTaskStore.getState();
      expect(state.tasks[0].title).toBe("Task Updated");
      expect(state.tasks[0].sections).toEqual(sections);
    });

    it("replaces sections when WS payload has non-empty sections", () => {
      const oldSections = [
        {
          type: "checklist_item" as const,
          content: "Old",
          order: 1,
          done: false,
          done_at: null,
        },
      ];
      const newSections = [
        {
          type: "constraint" as const,
          content: "New",
          order: 1,
          done: null,
          done_at: null,
        },
      ];
      const original = createMockTask({ id: "task-1", sections: oldSections });
      useTaskStore.getState().setTasks([original]);

      const wsPayload = createMockTask({ id: "task-1", sections: newSections });
      useTaskStore.getState().upsertTask(wsPayload);

      expect(useTaskStore.getState().tasks[0].sections).toEqual(newSections);
    });

    it("preserves existing code_refs when WS payload has empty code_refs", () => {
      const codeRefs = [
        {
          path: "src/main.rs",
          line_start: 1,
          line_end: 10,
          name: null,
          description: null,
        },
      ];
      const original = createMockTask({ id: "task-1", code_refs: codeRefs });
      useTaskStore.getState().setTasks([original]);

      const wsPayload = createMockTask({
        id: "task-1",
        title: "Updated",
        code_refs: [],
      });
      useTaskStore.getState().upsertTask(wsPayload);

      expect(useTaskStore.getState().tasks[0].code_refs).toEqual(codeRefs);
    });

    it("preserves existing dependency_ids when WS payload has empty dependency_ids", () => {
      const depIds = ["dep-1", "dep-2"];
      const original = createMockTask({ id: "task-1", dependency_ids: depIds });
      useTaskStore.getState().setTasks([original]);

      const wsPayload = createMockTask({
        id: "task-1",
        title: "Updated",
        dependency_ids: [],
      });
      useTaskStore.getState().upsertTask(wsPayload);

      expect(useTaskStore.getState().tasks[0].dependency_ids).toEqual(depIds);
    });

    it("replaces dependency_ids when WS payload has non-empty dependency_ids", () => {
      const original = createMockTask({
        id: "task-1",
        dependency_ids: ["old-dep"],
      });
      useTaskStore.getState().setTasks([original]);

      const wsPayload = createMockTask({
        id: "task-1",
        dependency_ids: ["new-dep-1", "new-dep-2"],
      });
      useTaskStore.getState().upsertTask(wsPayload);

      expect(useTaskStore.getState().tasks[0].dependency_ids).toEqual([
        "new-dep-1",
        "new-dep-2",
      ]);
    });

    it("preserves existing tags when WS payload has empty tags", () => {
      const tags = ["frontend", "urgent"];
      const original = createMockTask({ id: "task-1", tags });
      useTaskStore.getState().setTasks([original]);

      const wsPayload = createMockTask({
        id: "task-1",
        title: "Updated",
        tags: [],
      });
      useTaskStore.getState().upsertTask(wsPayload);

      expect(useTaskStore.getState().tasks[0].tags).toEqual(tags);
    });

    it("replaces tags when WS payload has non-empty tags", () => {
      const original = createMockTask({ id: "task-1", tags: ["old-tag"] });
      useTaskStore.getState().setTasks([original]);

      const wsPayload = createMockTask({
        id: "task-1",
        tags: ["new-tag-1", "new-tag-2"],
      });
      useTaskStore.getState().upsertTask(wsPayload);

      expect(useTaskStore.getState().tasks[0].tags).toEqual([
        "new-tag-1",
        "new-tag-2",
      ]);
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

    it("updates selectedTask when a new task is inserted matching selectedTaskId", () => {
      // Scenario: user navigates to task-1 (sets selectedTaskId), but the task
      // hasn't been fetched into the list yet. Then a WS broadcast inserts it.
      useTaskStore.getState().selectTask("task-new", null);

      const task = createMockTask({ id: "task-new", title: "Arrived via WS" });
      useTaskStore.getState().upsertTask(task);

      const state = useTaskStore.getState();
      expect(state.selectedTask?.title).toBe("Arrived via WS");
      expect(state.selectedTask?.id).toBe("task-new");
    });

    it("does not update selectedTask when a new task is inserted not matching selectedTaskId", () => {
      const existingSelected = createMockTask({
        id: "task-selected",
        title: "Selected",
      });
      useTaskStore.getState().selectTask("task-selected", existingSelected);

      const task = createMockTask({
        id: "task-other",
        title: "Other new task",
      });
      useTaskStore.getState().upsertTask(task);

      const state = useTaskStore.getState();
      expect(state.selectedTask?.title).toBe("Selected");
      expect(state.selectedTaskId).toBe("task-selected");
    });

    it("does not update selectedTask when the upserted task is different from selected", () => {
      const task1 = createMockTask({ id: "task-1", title: "Task 1" });
      const task2 = createMockTask({ id: "task-2", title: "Task 2" });
      useTaskStore.getState().setTasks([task1, task2]);
      useTaskStore.getState().selectTask("task-1", task1);

      const updatedTask2 = createMockTask({
        id: "task-2",
        title: "Task 2 Updated",
      });
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

      useTaskStore
        .getState()
        .upsertTask(createMockTask({ id: "task-2", title: "Second Updated" }));

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
      const tasksBefore = useTaskStore.getState().tasks;

      useTaskStore.getState().removeTask("nonexistent");

      expect(useTaskStore.getState().tasks).toBe(tasksBefore);
    });
  });

  describe("reconcileTask", () => {
    it("does not insert tasks from a different active workflow filter", () => {
      useTaskStore.getState().setActiveFilter({
        step_names: null,
        levels: null,
        tags: null,
        root_only: null,
        children_of: null,
        search: null,
        workflow_id: "workflow-visible",
        step_id: null,
      });

      useTaskStore.getState().reconcileTask(
        createMockTask({
          id: "wrong-workflow",
          workflow_id: "workflow-hidden",
        })
      );

      expect(useTaskStore.getState().tasks).toEqual([]);
    });

    it("removes existing tasks that leave the active workflow filter", () => {
      const task = createMockTask({
        id: "workflow-task",
        workflow_id: "workflow-visible",
      });
      useTaskStore.getState().setActiveFilter({
        step_names: null,
        levels: null,
        tags: null,
        root_only: null,
        children_of: null,
        search: null,
        workflow_id: "workflow-visible",
        step_id: null,
      });
      useTaskStore.getState().setTasks([task]);

      useTaskStore.getState().reconcileTask({
        ...task,
        workflow_id: "workflow-hidden",
      });

      expect(useTaskStore.getState().tasks).toEqual([]);
    });
  });

  describe("replaceTaskRunControls", () => {
    it("replaces run_controls on an existing task row", () => {
      const task = createMockTask({ id: "task-1", run_controls: null });
      const activeRun = createMockTaskRun({
        id: "run-active",
        task_id: "task-1",
      });
      const runControls = createMockTaskRunControls(activeRun);
      useTaskStore.getState().setTasks([task]);

      useTaskStore.getState().replaceTaskRunControls("task-1", runControls);

      const stored = useTaskStore.getState().tasks[0];
      expect(stored.run_controls).toEqual(runControls);
      expect(stored.run_controls?.active_run?.id).toBe("run-active");
      expect(stored.run_controls?.stoppable).toBe(true);
    });

    it("updates selectedTask when the selected task receives run controls", () => {
      const selected = createMockTask({
        id: "task-selected",
        run_controls: null,
      });
      const activeRun = createMockTaskRun({
        id: "run-selected",
        task_id: "task-selected",
      });
      const runControls = createMockTaskRunControls(activeRun);
      useTaskStore.getState().setTasks([selected]);
      useTaskStore.getState().selectTask("task-selected", selected);

      useTaskStore
        .getState()
        .replaceTaskRunControls("task-selected", runControls);

      const state = useTaskStore.getState();
      expect(state.selectedTask?.run_controls).toEqual(runControls);
      expect(state.tasks[0].run_controls?.active_run?.id).toBe("run-selected");
    });

    it("can replace existing controls with null from a payload", () => {
      const activeRun = createMockTaskRun({
        id: "run-complete",
        task_id: "task-1",
      });
      const task = createMockTask({
        id: "task-1",
        run_controls: createMockTaskRunControls(activeRun),
      });
      useTaskStore.getState().setTasks([task]);

      useTaskStore.getState().replaceTaskRunControls("task-1", null);

      expect(useTaskStore.getState().tasks[0].run_controls).toBeNull();
    });

    it("does not replace task objects when controls are unchanged", () => {
      const activeRun = createMockTaskRun({
        id: "run-same",
        task_id: "task-1",
      });
      const runControls = createMockTaskRunControls(activeRun);
      const task = createMockTask({
        id: "task-1",
        run_controls: runControls,
      });
      useTaskStore.getState().setTasks([task]);

      useTaskStore.getState().replaceTaskRunControls("task-1", runControls);

      expect(useTaskStore.getState().tasks[0]).toBe(task);
    });
  });
});
