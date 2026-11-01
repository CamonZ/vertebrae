import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActivities } from "./useActivities";
import type { ToolMessage } from "../types";
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: unknown) => void;
  onerror?: () => void;
  sent: { id: number; call: unknown }[] = [];
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(data: { id: number; call: unknown }) {
    this.sent.push(data);
  }
  complete(index: number, activity: string) {
    this.onmessage?.({
      data: {
        kind: "result",
        id: this.sent[index].id,
        analysis: {
          operations: [
            { activities: [activity], source: activity, relationships: [] },
          ],
        },
      },
    });
  }
}
const call = (evt: string): ToolMessage => ({
  type: "tool",
  evt,
  name: "exec",
  activityInput: { name: "exec_command", input: { cmd: evt } },
});
beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());
describe("activity worker ownership", () => {
  it("shares one worker and keeps out-of-order results scoped to their calls", async () => {
    const a = renderHook(() => useActivities([call("a")]));
    const b = renderHook(() => useActivities([call("b")]));
    expect(FakeWorker.instances).toHaveLength(1);
    const worker = FakeWorker.instances[0];
    act(() => worker.complete(1, "Git inspection"));
    await waitFor(() =>
      expect(b.result.current[0].operations[0].activities[0]).toBe(
        "Git inspection"
      )
    );
    expect(a.result.current[0].operations[0].activities[0]).toBeUndefined();
    a.unmount();
    expect(worker.terminate).not.toHaveBeenCalled();
    b.unmount();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("ignores late completions from a prior input and terminates on unmount", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ id }) => useActivities([call(id)]),
      { initialProps: { id: "a" } }
    );
    const old = FakeWorker.instances[0];
    rerender({ id: "b" });
    expect(old.terminate).not.toHaveBeenCalled();
    act(() => old.complete(0, "old scope"));
    expect(result.current[0].operations[0].activities[0]).toBeUndefined();
    const current = FakeWorker.instances[0];
    act(() => current.complete(1, "checks"));
    await waitFor(() =>
      expect(result.current[0].operations[0].activities[0]).toBe("checks")
    );
    unmount();
    expect(current.terminate).toHaveBeenCalledOnce();
  });
  it("restarts a failed worker once and recovers without remounting the thread", async () => {
    const { result, unmount } = renderHook(() => useActivities([call("a")]));
    act(() => FakeWorker.instances[0].onerror?.());
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    act(() => FakeWorker.instances[1].complete(0, "Git inspection"));
    await waitFor(() =>
      expect(result.current[0].operations[0].activities[0]).toBe(
        "Git inspection"
      )
    );
    unmount();
  });
  it("bounds automatic recovery and supports an explicit retry after persistent failure", async () => {
    const view = renderHook(({ retry }) => useActivities([call("a")], retry), {
      initialProps: { retry: 0 },
    });
    act(() => FakeWorker.instances[0].onerror?.());
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    act(() => FakeWorker.instances[1].onerror?.());
    await waitFor(() =>
      expect(view.result.current[0].analysisState).toBe("unavailable")
    );
    expect(FakeWorker.instances).toHaveLength(2);
    view.rerender({ retry: 1 });
    expect(FakeWorker.instances).toHaveLength(3);
    act(() => FakeWorker.instances[2].complete(0, "checks"));
    await waitFor(() =>
      expect(view.result.current[0].operations[0].activities[0]).toBe("checks")
    );
    view.unmount();
  });
  it("retains completed classifications while appended calls are still analyzing", async () => {
    const view = renderHook(({ calls }) => useActivities(calls), {
      initialProps: { calls: [call("a")] },
    });
    act(() => FakeWorker.instances[0].complete(0, "Git inspection"));
    await waitFor(() =>
      expect(view.result.current[0].operations[0].activities[0]).toBe(
        "Git inspection"
      )
    );
    view.rerender({ calls: [call("a"), call("b")] });
    expect(view.result.current[0].operations[0].activities[0]).toBe(
      "Git inspection"
    );
    expect(view.result.current[1].analysisState).toBe("loading");
    expect(FakeWorker.instances).toHaveLength(1);
    act(() => FakeWorker.instances[0].complete(1, "checks"));
    await waitFor(() =>
      expect(view.result.current[1].operations[0].activities[0]).toBe("checks")
    );
    view.unmount();
  });
  it("recovers after a timeout while retaining classifications that already completed", async () => {
    vi.useFakeTimers();
    const view = renderHook(() => useActivities([call("a"), call("b")]));
    try {
      await act(async () => FakeWorker.instances[0].complete(0, "checks"));
      expect(view.result.current[0].operations[0].activities[0]).toBe("checks");
      await act(async () => vi.advanceTimersByTimeAsync(10001));
      expect(FakeWorker.instances).toHaveLength(2);
      expect(view.result.current[0].operations[0].activities[0]).toBe("checks");
      await act(async () =>
        FakeWorker.instances[1].complete(0, "Git inspection")
      );
      expect(view.result.current[1].operations[0].activities[0]).toBe(
        "Git inspection"
      );
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
  it("recovers from a transient constructor failure", async () => {
    let attempts = 0;
    class RecoveringWorker extends FakeWorker {
      constructor() {
        if (attempts++ === 0)
          throw new Error("transient worker startup failure");
        super();
      }
    }
    vi.stubGlobal("Worker", RecoveringWorker);
    const view = renderHook(() => useActivities([call("a")]));
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    expect(attempts).toBe(2);
    act(() => FakeWorker.instances[0].complete(0, "checks"));
    await waitFor(() =>
      expect(view.result.current[0].operations[0].activities[0]).toBe("checks")
    );
    view.unmount();
  });
  it("does not start a worker for oversized inputs", async () => {
    renderHook(() => useActivities([call("x".repeat(131073))]));
    await act(async () => {});
    expect(FakeWorker.instances).toHaveLength(0);
  });
});

it("uses typed failure policy even when diagnostic wording suggests another phase", async () => {
  const view = renderHook(() => useActivities([call("typed-failure")]));
  const worker = FakeWorker.instances[0];
  act(() =>
    worker.onmessage?.({
      data: {
        kind: "error",
        id: worker.sent[0].id,
        error: {
          phase: "analysis",
          retryable: false,
          message: "Parser initialization failed: user text",
        },
      },
    })
  );
  await waitFor(() =>
    expect(view.result.current[0].failure?.phase).toBe("analysis")
  );
  expect(FakeWorker.instances).toHaveLength(1);
  view.unmount();
  const next = renderHook(() => useActivities([call("localized-failure")]));
  const initial = FakeWorker.instances[1];
  act(() =>
    initial.onmessage?.({
      data: {
        kind: "error",
        id: initial.sent[0].id,
        error: {
          phase: "initialization",
          retryable: true,
          message: "localized diagnostic",
        },
      },
    })
  );
  await waitFor(() => expect(FakeWorker.instances).toHaveLength(3));
  act(() => FakeWorker.instances[2].complete(0, "checks"));
  await waitFor(() =>
    expect(next.result.current[0].operations[0].activities).toEqual(["checks"])
  );
  next.unmount();
});

it("projects MCP query arguments and refreshes when the query changes", async () => {
  const view = renderHook(
    ({ query }) =>
      useActivities([
        {
          ...call("mcp"),
          activityInput: {
            name: "mcp__tidewave__execute_sql_query",
            input: { query, unrelated: "not projected" },
          },
        },
      ]),
    { initialProps: { query: "SELECT 1" } }
  );
  const worker = FakeWorker.instances[0];
  expect(worker.sent[0].call).toEqual({
    name: "mcp__tidewave__execute_sql_query",
    input: { query: "SELECT 1" },
  });
  view.rerender({ query: "DELETE FROM users" });
  expect(worker.sent[1].call).toEqual({
    name: "mcp__tidewave__execute_sql_query",
    input: { query: "DELETE FROM users" },
  });
  view.unmount();
});
