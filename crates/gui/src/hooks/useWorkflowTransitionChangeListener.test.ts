import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowTransitionChangedEvent } from "../bindings";
import { createMockWorkflow } from "../test/test-utils";
import { queryClient, queryKeys } from "../query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { useNotificationStore } from "../stores";

const listen = vi.fn();
let handlers: Array<
  (event: { payload: WorkflowTransitionChangedEvent }) => void
> = [];

vi.mock("../bindings", () => ({
  events: {
    workflowTransitionChangedEvent: {
      listen: (
        handler: (event: { payload: WorkflowTransitionChangedEvent }) => void
      ) => {
        handlers.push(handler);
        listen(handler);
        return Promise.resolve(() => {});
      },
    },
  },
}));

import { useWorkflowTransitionChangeListener } from "./useWorkflowTransitionChangeListener";

describe("useWorkflowTransitionChangeListener", () => {
  beforeEach(() => {
    resetProjectScopedStores();
    queryClient.clear();
    useNotificationStore.getState().clearNotifications();
    handlers = [];
    listen.mockClear();
  });

  it("updates only the active generation and derives names from workflow cache", async () => {
    const generation = getProjectScopeGeneration();
    queryClient.setQueryData(queryKeys.workflows.list(generation), [
      createMockWorkflow({ id: "from", name: "From renamed" }),
      createMockWorkflow({ id: "to", name: "To renamed" }),
    ]);
    renderHook(() => useWorkflowTransitionChangeListener());
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));

    act(() => {
      handlers[0]({
        payload: {
          transition_id: "transition-1",
          from_workflow_id: "from",
          to_workflow_id: "to",
          target_step_id: null,
          label: "go",
          change_type: "Created",
        },
      });
    });

    expect(
      queryClient.getQueryData(queryKeys.workflowTransitions.list(generation))
    ).toEqual([
      expect.objectContaining({
        from_workflow_name: "From renamed",
        to_workflow_name: "To renamed",
      }),
    ]);
    expect(
      queryClient.getQueryData(
        queryKeys.workflowTransitions.list(generation + 1)
      )
    ).toBeUndefined();
  });

  it("ignores a delayed event from the previous project generation", async () => {
    const oldGeneration = getProjectScopeGeneration();
    renderHook(() => useWorkflowTransitionChangeListener());
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    const staleHandler = handlers[0];

    act(() => resetProjectScopedStores());
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(2));

    act(() => {
      staleHandler({
        payload: {
          transition_id: "stale-transition",
          from_workflow_id: "from",
          to_workflow_id: "to",
          target_step_id: null,
          label: "stale",
          change_type: "Created",
        },
      });
    });

    expect(
      queryClient.getQueryData(
        queryKeys.workflowTransitions.list(oldGeneration + 1)
      )
    ).toBeUndefined();
  });
});
