import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type Task } from "../bindings";
import {
  queryClient,
  upsertStepInQueryCache,
  upsertWorkflowInQueryCache,
} from "../query";
import {
  createMockStep,
  createMockTask,
  createMockWorkflow,
} from "../test/test-utils";
import {
  resetProjectScopedStores,
  getProjectScopeGeneration,
} from "../stores/projectScopedStores";
import { useTaskLocation } from "./useTaskLocation";

vi.mock("../bindings", async () => {
  const actual =
    await vi.importActual<typeof import("../bindings")>("../bindings");
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getStep: vi.fn(),
      listWorkflows: vi.fn(),
    },
  };
});

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

describe("useTaskLocation", () => {
  beforeEach(() => {
    resetProjectScopedStores();
    queryClient.clear();
    vi.mocked(commands.getStep).mockReset();
    vi.mocked(commands.listWorkflows).mockReset();
  });

  it("reflects Step and Workflow renames without refetching the Task", async () => {
    const generation = getProjectScopeGeneration();
    const task = createMockTask({
      workflow_id: null,
      current_step_id: "step-1",
      workflow_name: "stale workflow",
      step_name: "stale step",
      step_type: "execute",
    });
    const step = createMockStep({
      id: "step-1",
      workflow_id: "workflow-1",
      name: "Before step",
      step_type: "execute",
    });
    const workflow = createMockWorkflow({
      id: "workflow-1",
      name: "Before workflow",
    });
    upsertStepInQueryCache(step, generation);
    upsertWorkflowInQueryCache(workflow, generation);

    const { result } = renderHook(() => useTaskLocation(task), { wrapper });
    await waitFor(() =>
      expect(result.current.workflowName).toBe("Before workflow")
    );

    act(() => {
      upsertStepInQueryCache(
        { ...step, name: "After step", step_type: "evaluate" },
        generation
      );
      upsertWorkflowInQueryCache(
        { ...workflow, name: "After workflow" },
        generation
      );
    });

    await waitFor(() => {
      expect(result.current).toMatchObject({
        status: "assigned",
        workflowName: "After workflow",
        stepName: "After step",
        stepType: "evaluate",
      });
    });
    expect(commands.getStep).not.toHaveBeenCalled();
    expect(commands.listWorkflows).not.toHaveBeenCalled();
  });

  it("derives a null Task.workflow_id through the resolved Step workflow", () => {
    const task: Task = createMockTask({
      workflow_id: null,
      current_step_id: "step-1",
    });
    const generation = getProjectScopeGeneration();
    upsertStepInQueryCache(
      createMockStep({ id: "step-1", workflow_id: "workflow-1", name: "Step" }),
      generation
    );
    upsertWorkflowInQueryCache(
      createMockWorkflow({ id: "workflow-1", name: "Workflow" }),
      generation
    );

    const { result } = renderHook(() => useTaskLocation(task), { wrapper });
    expect(result.current.workflowId).toBe("workflow-1");
    expect(result.current.workflowName).toBe("Workflow");
  });
});
