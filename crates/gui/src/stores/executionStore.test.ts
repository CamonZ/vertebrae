import { describe, it, expect, beforeEach } from "vitest";
import { useExecutionStore } from "./executionStore";
import type { StepExecution } from "../bindings";

function createMockExecution(overrides?: Partial<StepExecution>): StepExecution {
  return {
    id: "exec-1",
    task_id: "task-1",
    workflow_id: "wf-1",
    step_name: "backlog",
    started_at: new Date().toISOString(),
    completed_at: null,
    status: "in_progress",
    ...overrides,
  };
}

describe("executionStore", () => {
  beforeEach(() => {
    useExecutionStore.setState({ executions: [], executionsByTaskId: {} });
  });

  describe("initial state", () => {
    it("has empty executions array", () => {
      expect(useExecutionStore.getState().executions).toEqual([]);
    });
  });

  describe("setExecutions", () => {
    it("sets the executions list", () => {
      const executions = [
        createMockExecution({ id: "exec-1" }),
        createMockExecution({ id: "exec-2" }),
      ];

      useExecutionStore.getState().setExecutions(executions);

      const state = useExecutionStore.getState();
      expect(state.executions).toHaveLength(2);
      expect(state.executions[0].id).toBe("exec-1");
      expect(state.executions[1].id).toBe("exec-2");
    });

    it("replaces existing executions", () => {
      useExecutionStore.getState().setExecutions([createMockExecution({ id: "exec-1" })]);
      useExecutionStore.getState().setExecutions([createMockExecution({ id: "exec-2" })]);

      expect(useExecutionStore.getState().executions).toHaveLength(1);
      expect(useExecutionStore.getState().executions[0].id).toBe("exec-2");
    });
  });

  describe("upsertExecution", () => {
    it("adds a new execution when it does not exist", () => {
      const execution = createMockExecution({ id: "exec-new", step_name: "review" });

      useExecutionStore.getState().upsertExecution(execution);

      const state = useExecutionStore.getState();
      expect(state.executions).toHaveLength(1);
      expect(state.executions[0].id).toBe("exec-new");
      expect(state.executions[0].step_name).toBe("review");
    });

    it("updates an existing execution", () => {
      const original = createMockExecution({ id: "exec-1", status: "in_progress" });
      useExecutionStore.getState().setExecutions([original]);

      const updated = createMockExecution({ id: "exec-1", status: "completed" });
      useExecutionStore.getState().upsertExecution(updated);

      const state = useExecutionStore.getState();
      expect(state.executions).toHaveLength(1);
      expect(state.executions[0].status).toBe("completed");
    });

    it("preserves order of other executions", () => {
      const executions = [
        createMockExecution({ id: "exec-1", step_name: "first" }),
        createMockExecution({ id: "exec-2", step_name: "second" }),
        createMockExecution({ id: "exec-3", step_name: "third" }),
      ];
      useExecutionStore.getState().setExecutions(executions);

      useExecutionStore.getState().upsertExecution(
        createMockExecution({ id: "exec-2", step_name: "second-updated", status: "completed" })
      );

      const state = useExecutionStore.getState();
      expect(state.executions[0].id).toBe("exec-1");
      expect(state.executions[1].id).toBe("exec-2");
      expect(state.executions[1].step_name).toBe("second-updated");
      expect(state.executions[1].status).toBe("completed");
      expect(state.executions[2].id).toBe("exec-3");
    });

    it("also populates the per-task bucket cache", () => {
      const e = createMockExecution({ id: "exec-7", task_id: "task-A" });
      useExecutionStore.getState().upsertExecution(e);

      const state = useExecutionStore.getState();
      expect(state.executionsByTaskId["task-A"]).toHaveLength(1);
      expect(state.executionsByTaskId["task-A"][0].id).toBe("exec-7");
    });
  });

  describe("setExecutionsForTask", () => {
    it("scopes writes to a single task bucket without touching others", () => {
      const a1 = createMockExecution({ id: "a1", task_id: "task-A" });
      const a2 = createMockExecution({ id: "a2", task_id: "task-A" });
      const b1 = createMockExecution({ id: "b1", task_id: "task-B" });

      useExecutionStore.getState().setExecutionsForTask("task-A", [a1, a2]);
      useExecutionStore.getState().setExecutionsForTask("task-B", [b1]);

      const state = useExecutionStore.getState();
      expect(state.executionsByTaskId["task-A"].map((e) => e.id)).toEqual(["a1", "a2"]);
      expect(state.executionsByTaskId["task-B"].map((e) => e.id)).toEqual(["b1"]);
    });

    it("supports parallel writes to distinct buckets without clobbering", () => {
      // Simulate Promise.all fan-out by calling setExecutionsForTask for
      // many task ids in immediate succession.
      const writes = Array.from({ length: 10 }, (_, i) => ({
        taskId: `task-${i}`,
        execs: [createMockExecution({ id: `e-${i}`, task_id: `task-${i}` })],
      }));
      for (const w of writes) {
        useExecutionStore.getState().setExecutionsForTask(w.taskId, w.execs);
      }
      const state = useExecutionStore.getState();
      expect(Object.keys(state.executionsByTaskId)).toHaveLength(10);
      for (let i = 0; i < 10; i++) {
        expect(state.executionsByTaskId[`task-${i}`][0].id).toBe(`e-${i}`);
      }
    });
  });

  describe("upsertExecution writes through to the per-task bucket", () => {
    it("merges an in-flight WS upsert into an already-populated bucket", () => {
      const a1 = createMockExecution({ id: "a1", task_id: "task-A", status: "in_progress" });
      useExecutionStore.getState().setExecutionsForTask("task-A", [a1]);

      const a1Updated = createMockExecution({
        id: "a1",
        task_id: "task-A",
        status: "completed",
      });
      useExecutionStore.getState().upsertExecution(a1Updated);

      const bucket = useExecutionStore.getState().executionsByTaskId["task-A"];
      expect(bucket).toHaveLength(1);
      expect(bucket[0].status).toBe("completed");
    });

    it("creates a new bucket on first upsert when no fetch has populated it yet", () => {
      const fresh = createMockExecution({ id: "new", task_id: "task-Z" });
      useExecutionStore.getState().upsertExecution(fresh);

      const bucket = useExecutionStore.getState().executionsByTaskId["task-Z"];
      expect(bucket).toEqual([fresh]);
    });
  });

  describe("clearExecutionsForTask", () => {
    it("removes a single task bucket and leaves others intact", () => {
      const a = createMockExecution({ id: "a", task_id: "task-A" });
      const b = createMockExecution({ id: "b", task_id: "task-B" });
      useExecutionStore.getState().setExecutionsForTask("task-A", [a]);
      useExecutionStore.getState().setExecutionsForTask("task-B", [b]);

      useExecutionStore.getState().clearExecutionsForTask("task-A");

      const state = useExecutionStore.getState();
      expect(state.executionsByTaskId).not.toHaveProperty("task-A");
      expect(state.executionsByTaskId["task-B"]).toHaveLength(1);
    });
  });
});
