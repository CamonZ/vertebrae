import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepTransitionChangedEvent } from "../bindings";
import { queryClient, queryKeys } from "../query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { createMockStep } from "../test/test-utils";
import { useNotificationStore } from "../stores";

const { handlers, listen } = vi.hoisted(() => ({
  handlers: [] as Array<
    (event: { payload: StepTransitionChangedEvent }) => void
  >,
  listen: vi.fn(),
}));

vi.mock("../bindings", () => ({
  events: {
    stepTransitionChangedEvent: {
      listen: (
        handler: (event: { payload: StepTransitionChangedEvent }) => void
      ) => {
        handlers.push(handler);
        listen(handler);
        return Promise.resolve(vi.fn());
      },
    },
  },
}));

import { useStepTransitionChangeListener } from "./useStepTransitionChangeListener";

describe("useStepTransitionChangeListener", () => {
  beforeEach(() => {
    resetProjectScopedStores();
    useNotificationStore.getState().clearNotifications();
    handlers.length = 0;
    listen.mockClear();
    queryClient.clear();
  });

  it("applies created, updated and deleted edges to the source step cache", async () => {
    const key = queryKeys.steps.byId(getProjectScopeGeneration(), "from");
    queryClient.setQueryData(
      key,
      createMockStep({ id: "from", transitions_to: ["other"] })
    );
    renderHook(() => useStepTransitionChangeListener());
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    const emit = (payload: Partial<StepTransitionChangedEvent>) =>
      act(() =>
        handlers[0]({
          payload: {
            transition_id: "t-1",
            from_step_id: "from",
            to_step_id: "to",
            label: null,
            session: null,
            change_type: "Created",
            ...payload,
          },
        })
      );

    emit({});
    expect(queryClient.getQueryData(key)).toMatchObject({
      transitions_to: ["other", "to"],
      transition_sessions: {},
    });

    emit({ change_type: "Updated", session: { mode: "fork", step_id: null } });
    expect(queryClient.getQueryData(key)).toMatchObject({
      transitions_to: ["other", "to"],
      transition_sessions: { to: { mode: "fork", step_id: null } },
    });

    emit({ change_type: "Deleted" });
    expect(queryClient.getQueryData(key)).toMatchObject({
      transitions_to: ["other"],
      transition_sessions: {},
    });
  });

  it("ignores delayed events from a previous project generation", async () => {
    const onChange = vi.fn();
    renderHook(() =>
      useStepTransitionChangeListener({
        onStepTransitionChange: onChange,
      })
    );
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    const staleHandler = handlers[0];

    act(() => resetProjectScopedStores());
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(2));

    act(() => {
      staleHandler({
        payload: {
          transition_id: "stale-transition",
          from_step_id: "old-from",
          to_step_id: "old-to",
          label: null,
          session: null,
          change_type: "Created",
        },
      });
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });
});
