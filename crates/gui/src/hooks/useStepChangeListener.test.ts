import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepChangedEvent } from "../bindings";
import { createMockStep } from "../test/test-utils";
import { queryClient, queryKeys } from "../query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";

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
        },
      });
    });
    expect(
      queryClient.getQueryData(queryKeys.steps.byId(generation, step.id!))
    ).toEqual(step);

    act(() => {
      handler?.({
        payload: {
          step_id: step.id!,
          workflow_id: step.workflow_id,
          change_type: "Deleted",
          step: null,
        },
      });
    });
    expect(
      queryClient.getQueryData(queryKeys.steps.byId(generation, step.id!))
    ).toBeUndefined();
  });
});
