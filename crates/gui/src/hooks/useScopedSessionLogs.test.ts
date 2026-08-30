import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSessionLogStore } from "../stores/sessionLogStore";
import { useScopedSessionLogs } from "./useScopedSessionLogs";

function log(id: string, executionId: string) {
  return {
    id,
    step_execution_id: executionId,
    content: "{}",
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("useScopedSessionLogs", () => {
  beforeEach(() => {
    useSessionLogStore.getState().reset();
  });

  it("does not rerender for an execution outside the requested scope", () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useScopedSessionLogs(["e1"]);
    });
    const initialRenderCount = renderCount;

    act(() => {
      useSessionLogStore.getState().appendLog("e2", log("l2", "e2"));
      useSessionLogStore.getState().flushPending();
    });

    expect(renderCount).toBe(initialRenderCount);
    expect(result.current).toEqual({});
  });

  it("returns the complete bucket when an execution in scope changes", () => {
    const { result } = renderHook(() => useScopedSessionLogs(["e1"]));

    act(() => {
      useSessionLogStore.getState().appendLog("e1", log("l1", "e1"));
      useSessionLogStore.getState().flushPending();
    });

    expect(result.current.e1.logs).toEqual([log("l1", "e1")]);
    expect(result.current.e1.fallbackCost).toBe(0);
  });
});
