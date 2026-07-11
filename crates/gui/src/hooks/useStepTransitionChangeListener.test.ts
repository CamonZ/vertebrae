import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepTransitionChangedEvent } from "../bindings";
import { resetProjectScopedStores } from "../stores/projectScopedStores";
import { useToastStore } from "../stores/toastStore";

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
    useToastStore.getState().clearToasts();
    handlers.length = 0;
    listen.mockClear();
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
          change_type: "Created",
        },
      });
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
