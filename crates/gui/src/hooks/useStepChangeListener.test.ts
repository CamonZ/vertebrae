import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepChangedEvent } from "../bindings";
import { createMockStep } from "../test/test-utils";
import { queryClient, queryKeys } from "../query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { useNotificationStore } from "../stores";

let handler: ((event: { payload: StepChangedEvent }) => void) | null = null;
const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));

vi.mock("../bindings", () => ({
  events: { stepChangedEvent: { listen } },
}));

import { useStepChangeListener } from "./useStepChangeListener";

describe("useStepChangeListener", () => {
  beforeEach(() => {
    resetProjectScopedStores();
    queryClient.clear();
    useNotificationStore.getState().clearNotifications();
    handler = null;
    listen.mockClear();
    listen.mockImplementation(
      (nextHandler: (event: { payload: StepChangedEvent }) => void) => {
        handler = nextHandler;
        return Promise.resolve(() => {});
      }
    );
  });

  it("upserts and removes Step records in the generation cache", async () => {
    const generation = getProjectScopeGeneration();
    renderHook(() => useStepChangeListener());
    await waitFor(() => expect(listen).toHaveBeenCalled());
    const step = createMockStep({ id: "step-1", name: "Renamed" });

    act(() => {
      handler?.({
        payload: {
          step_id: step.id!,
          workflow_id: step.workflow_id,
          change_type: "Updated",
          step,
          includes_transitions: true,
        },
      });
    });
    expect(
      queryClient.getQueryData(queryKeys.steps.byId(generation, step.id!))
    ).toEqual(step);
    // Realtime changes refresh caches without adding Activity entries.
    expect(useNotificationStore.getState().notifications).toEqual([]);

    act(() => {
      handler?.({
        payload: {
          step_id: step.id!,
          workflow_id: step.workflow_id,
          change_type: "Deleted",
          step: null,
          includes_transitions: false,
        },
      });
    });
    expect(
      queryClient.getQueryData(queryKeys.steps.byId(generation, step.id!))
    ).toBeUndefined();
  });

  it("keeps cached edges when a realtime step update omits them", async () => {
    const generation = getProjectScopeGeneration();
    renderHook(() => useStepChangeListener());
    await waitFor(() => expect(listen).toHaveBeenCalled());
    const key = queryKeys.steps.byId(generation, "step-1");
    queryClient.setQueryData(
      key,
      createMockStep({
        id: "step-1",
        transitions_to: ["step-2", "step-3"],
        transition_sessions: { "step-2": { mode: "fork", step_id: null } },
      })
    );

    act(() => {
      handler?.({
        payload: {
          step_id: "step-1",
          workflow_id: "workflow-1",
          change_type: "Updated",
          step: createMockStep({
            id: "step-1",
            name: "Renamed",
            transitions_to: [],
            transition_sessions: {},
          }),
          includes_transitions: false,
        },
      });
    });

    expect(queryClient.getQueryData(key)).toMatchObject({
      name: "Renamed",
      transitions_to: ["step-2", "step-3"],
      transition_sessions: { "step-2": { mode: "fork", step_id: null } },
    });
  });

  it("refetches instead of seeding a realtime step without its edges", async () => {
    const generation = getProjectScopeGeneration();
    renderHook(() => useStepChangeListener());
    await waitFor(() => expect(listen).toHaveBeenCalled());

    act(() => {
      handler?.({
        payload: {
          step_id: "step-9",
          workflow_id: "workflow-1",
          change_type: "Created",
          step: createMockStep({ id: "step-9", transitions_to: [] }),
          includes_transitions: false,
        },
      });
    });

    expect(
      queryClient.getQueryData(queryKeys.steps.byId(generation, "step-9"))
    ).toBeUndefined();
  });
});
