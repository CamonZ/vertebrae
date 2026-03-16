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
    useExecutionStore.setState({ executions: [] });
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
  });
});
