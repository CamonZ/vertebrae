import { beforeEach, describe, expect, it } from "vitest";
import { queryClient, queryKeys } from "../query";
import { createMockStep } from "../test/test-utils";
import { getProjectScopeGeneration } from "./projectScopedStores";
import { useWorkflowSelectionStore } from "./workflowSelectionStore";

describe("workflow selection store", () => {
  beforeEach(() => useWorkflowSelectionStore.getState().reset());

  it("sets only the workflow for workflow-panel selection", () => {
    useWorkflowSelectionStore.getState().selectWorkflow("workflow-1");
    expect(useWorkflowSelectionStore.getState()).toMatchObject({
      selectedWorkflowId: "workflow-1",
      selectedStepId: null,
    });
  });

  it("sets both IDs for step-panel selection", () => {
    useWorkflowSelectionStore.getState().selectStep("workflow-1", "step-1");
    expect(useWorkflowSelectionStore.getState()).toMatchObject({
      selectedWorkflowId: "workflow-1",
      selectedStepId: "step-1",
    });
  });

  it("clears selection without affecting query-owned records", () => {
    useWorkflowSelectionStore.getState().selectStep("workflow-1", "step-1");
    const step = createMockStep({ id: "step-1" });
    queryClient.setQueryData(
      queryKeys.steps.byId(getProjectScopeGeneration(), step.id!),
      step
    );
    useWorkflowSelectionStore.getState().clearSelection();
    expect(useWorkflowSelectionStore.getState()).toMatchObject({
      selectedWorkflowId: null,
      selectedStepId: null,
    });
    expect(
      queryClient.getQueryData(
        queryKeys.steps.byId(getProjectScopeGeneration(), step.id!)
      )
    ).toEqual(step);
  });
});
