import { describe, it, expect, beforeEach } from "vitest";
import { useWorkflowStore } from "./workflowStore";
import { createMockWorkflow, createMockTask } from "../test/test-utils";

describe("workflowStore", () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      workflows: [],
      currentWorkflow: null,
      isLoading: false,
    });
  });

  describe("upsertWorkflow", () => {
    it("adds a new workflow when it does not exist", () => {
      const workflow = createMockWorkflow({ id: "wf-1", name: "New Workflow" });

      useWorkflowStore.getState().upsertWorkflow(workflow);

      const state = useWorkflowStore.getState();
      expect(state.workflows).toHaveLength(1);
      expect(state.workflows[0].id).toBe("wf-1");
      expect(state.workflows[0].name).toBe("New Workflow");
    });

    it("updates an existing workflow in the list", () => {
      const original = createMockWorkflow({ id: "wf-1", name: "Original" });
      useWorkflowStore.getState().setWorkflows([original]);

      const updated = createMockWorkflow({ id: "wf-1", name: "Updated" });
      useWorkflowStore.getState().upsertWorkflow(updated);

      const state = useWorkflowStore.getState();
      expect(state.workflows).toHaveLength(1);
      expect(state.workflows[0].name).toBe("Updated");
    });

    it("updates currentWorkflow when the upserted workflow matches", () => {
      const workflow = createMockWorkflow({ id: "wf-1", name: "Current" });
      const tasks = [createMockTask({ id: "t-1" })];
      useWorkflowStore.getState().setWorkflows([workflow]);
      useWorkflowStore.getState().setCurrentWorkflow({ workflow, tasks });

      const updated = createMockWorkflow({ id: "wf-1", name: "Updated Current" });
      useWorkflowStore.getState().upsertWorkflow(updated);

      const state = useWorkflowStore.getState();
      expect(state.currentWorkflow?.workflow.name).toBe("Updated Current");
      expect(state.currentWorkflow?.tasks).toEqual(tasks);
    });

    it("does not update currentWorkflow when the upserted workflow is different", () => {
      const wf1 = createMockWorkflow({ id: "wf-1", name: "Current" });
      const wf2 = createMockWorkflow({ id: "wf-2", name: "Other" });
      useWorkflowStore.getState().setWorkflows([wf1, wf2]);
      useWorkflowStore.getState().setCurrentWorkflow({ workflow: wf1, tasks: [] });

      const updatedWf2 = createMockWorkflow({ id: "wf-2", name: "Other Updated" });
      useWorkflowStore.getState().upsertWorkflow(updatedWf2);

      const state = useWorkflowStore.getState();
      expect(state.currentWorkflow?.workflow.name).toBe("Current");
    });
  });

  describe("removeWorkflow", () => {
    it("removes a workflow from the list by ID", () => {
      const workflows = [
        createMockWorkflow({ id: "wf-1", name: "First" }),
        createMockWorkflow({ id: "wf-2", name: "Second" }),
      ];
      useWorkflowStore.getState().setWorkflows(workflows);

      useWorkflowStore.getState().removeWorkflow("wf-1");

      const state = useWorkflowStore.getState();
      expect(state.workflows).toHaveLength(1);
      expect(state.workflows[0].id).toBe("wf-2");
    });

    it("clears currentWorkflow when the removed workflow is the current one", () => {
      const workflow = createMockWorkflow({ id: "wf-1", name: "Current" });
      useWorkflowStore.getState().setWorkflows([workflow]);
      useWorkflowStore.getState().setCurrentWorkflow({ workflow, tasks: [] });

      useWorkflowStore.getState().removeWorkflow("wf-1");

      const state = useWorkflowStore.getState();
      expect(state.workflows).toHaveLength(0);
      expect(state.currentWorkflow).toBeNull();
    });

    it("does not clear currentWorkflow when a different workflow is removed", () => {
      const wf1 = createMockWorkflow({ id: "wf-1", name: "Current" });
      const wf2 = createMockWorkflow({ id: "wf-2", name: "Other" });
      useWorkflowStore.getState().setWorkflows([wf1, wf2]);
      useWorkflowStore.getState().setCurrentWorkflow({ workflow: wf1, tasks: [] });

      useWorkflowStore.getState().removeWorkflow("wf-2");

      const state = useWorkflowStore.getState();
      expect(state.workflows).toHaveLength(1);
      expect(state.currentWorkflow?.workflow.name).toBe("Current");
    });

    it("is a no-op when the workflow ID does not exist", () => {
      const workflow = createMockWorkflow({ id: "wf-1" });
      useWorkflowStore.getState().setWorkflows([workflow]);

      useWorkflowStore.getState().removeWorkflow("nonexistent");

      expect(useWorkflowStore.getState().workflows).toHaveLength(1);
    });
  });

  describe("clearCurrentWorkflow", () => {
    it("clears the current workflow", () => {
      const workflow = createMockWorkflow({ id: "wf-1", name: "Active" });
      useWorkflowStore.getState().setCurrentWorkflow({ workflow, tasks: [] });

      useWorkflowStore.getState().clearCurrentWorkflow();

      expect(useWorkflowStore.getState().currentWorkflow).toBeNull();
    });
  });
});
