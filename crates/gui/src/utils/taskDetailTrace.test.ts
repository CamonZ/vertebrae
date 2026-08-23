import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureTaskDetailTrace,
  finishTaskDetailTrace,
  getTaskDetailTraceId,
  startTaskDetailTrace,
  traceTaskDetailPhaseOnce,
} from "./taskDetailTrace";
import { useDebugStore } from "../stores/debugStore";

describe("task detail tracing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useDebugStore.getState().clearLogs();
    performance.clearMarks();
    performance.clearMeasures();
  });

  it("correlates phases and only records once-only phases once", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    const traceId = startTaskDetailTrace("task-123", "tasks-page");
    expect(ensureTaskDetailTrace("task-123", "other-source")).toBe(traceId);
    expect(
      traceTaskDetailPhaseOnce("task-123", "detail-data-ready", {
        sections: 2,
      })
    ).toBe(traceId);
    expect(
      traceTaskDetailPhaseOnce("task-123", "detail-data-ready", {
        sections: 3,
      })
    ).toBe(traceId);

    expect(getTaskDetailTraceId("task-123")).toBe(traceId);
    expect(finishTaskDetailTrace("task-123", { artifacts: 1 })).toBe(traceId);
    expect(getTaskDetailTraceId("task-123")).toBeNull();
    expect(debug).toHaveBeenCalledTimes(3);
    expect(debug.mock.calls.map(([, payload]) => payload.phase)).toEqual([
      "selection-start",
      "detail-data-ready",
      "content-painted",
    ]);
  });
});
