import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { commands, type ActivityInput } from "../../../bindings";
import type { ToolMessage } from "../types";
import { associationSyntax, useActivities } from "./useActivities";

vi.mock("../../../bindings", () => ({
  commands: { analyzeToolActivities: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

const analyze = vi.mocked(commands.analyzeToolActivities);
const call = (cmd: string): ToolMessage => ({
  evt: cmd,
  type: "tool",
  status: "done",
  activityInput: { name: "exec_command", input: { cmd, ignored: "raw only" } },
});
const success = (...sources: string[]) => ({
  status: "ok" as const,
  data: sources.map((source) => ({
    operations: [{ source, activities: ["checks"], relationships: [] }],
  })),
});

beforeEach(() => {
  analyze.mockReset();
});

it("sends one projected command in call order and ignores result-only updates", async () => {
  analyze.mockResolvedValue(success("a", "b"));
  const view = renderHook(({ calls }) => useActivities(calls), {
    initialProps: { calls: [call("a"), call("b")] },
  });
  expect(view.result.current.map((row) => row.analysisState)).toEqual([
    "loading",
    "loading",
  ]);
  await waitFor(() =>
    expect(view.result.current).toEqual(success("a", "b").data)
  );
  expect(analyze).toHaveBeenCalledExactlyOnceWith([
    { name: "exec_command", input: { cmd: "a" } },
    { name: "exec_command", input: { cmd: "b" } },
  ]);
  view.rerender({
    calls: [{ ...call("a"), recordedResult: "done" }, call("b")],
  });
  expect(analyze).toHaveBeenCalledTimes(1);
});

it("keeps finished rows visible while an appended group is loading", async () => {
  analyze.mockResolvedValueOnce(success("a"));
  const view = renderHook(({ calls }) => useActivities(calls), {
    initialProps: { calls: [call("a")] },
  });
  await waitFor(() => expect(view.result.current).toEqual(success("a").data));
  const next = deferred<Awaited<ReturnType<typeof analyze>>>();
  analyze.mockReturnValueOnce(next.promise);
  view.rerender({ calls: [call("a"), call("b")] });
  expect(view.result.current[0]).toEqual(success("a").data[0]);
  expect(view.result.current[1].analysisState).toBe("loading");
  expect(analyze).toHaveBeenLastCalledWith([
    { name: "exec_command", input: { cmd: "b" } },
  ]);
  await act(async () => next.resolve(success("b")));
  expect(view.result.current).toEqual(success("a", "b").data);
});

it("retains each unanalysable call and parses its siblings", async () => {
  analyze.mockResolvedValue(success("small"));
  const view = renderHook(() =>
    useActivities([call("x".repeat(131073)), call("small")])
  );
  await waitFor(() =>
    expect(view.result.current[1]).toEqual(success("small").data[0])
  );
  expect(view.result.current[0].analysisState).toBe("unavailable");
  expect(analyze).toHaveBeenCalledExactlyOnceWith([
    { name: "exec_command", input: { cmd: "small" } },
  ]);
});

it("shows command errors, rejected invocations and an explicit retry", async () => {
  analyze
    .mockResolvedValueOnce({
      status: "error",
      error: { message: "Activity analysis queue is full." },
    })
    .mockRejectedValueOnce(new Error("IPC disconnected"))
    .mockResolvedValueOnce(success("a"));
  const view = renderHook(({ retry }) => useActivities([call("a")], retry), {
    initialProps: { retry: 0 },
  });
  await waitFor(() =>
    expect(view.result.current[0].analysisState).toBe("unavailable")
  );
  expect(view.result.current[0].operations[0].unresolved).toBe(
    "Activity analysis queue is full."
  );
  view.rerender({ retry: 1 });
  await waitFor(() =>
    expect(view.result.current[0].operations[0].unresolved).toBe(
      "IPC disconnected"
    )
  );
  view.rerender({ retry: 2 });
  await waitFor(() => expect(view.result.current).toEqual(success("a").data));
});

it("refreshes when an MCP query changes", async () => {
  analyze.mockResolvedValue(success("a"));
  const view = renderHook(
    ({ query }) =>
      useActivities([
        {
          ...call("mcp"),
          activityInput: { name: "mcp__service__query", input: { query } },
        },
      ]),
    { initialProps: { query: "first" } }
  );
  await waitFor(() =>
    expect(view.result.current[0].analysisState).toBeUndefined()
  );
  view.rerender({ query: "second" });
  expect(analyze).toHaveBeenLastCalledWith([
    { name: "mcp__service__query", input: { query: "second" } },
  ]);
});

it("exposes the same parser without decisions for association evidence", async () => {
  analyze.mockResolvedValue(success("vtb add"));
  const input: ActivityInput = {
    name: "exec_command",
    input: { cmd: "vtb add" },
  };
  await expect(associationSyntax(input)).resolves.toEqual(
    success("vtb add").data[0]
  );
  expect(analyze).toHaveBeenCalledExactlyOnceWith([input]);
});

it("keeps a backend overflow fallback local to its call", async () => {
  analyze.mockResolvedValue({
    status: "ok",
    data: [null, ...success("second").data],
  });
  const view = renderHook(() =>
    useActivities([call("overflow"), call("second")])
  );
  await waitFor(() =>
    expect(view.result.current[1]).toEqual(success("second").data[0])
  );
  expect(view.result.current[0].analysisState).toBe("unavailable");
});
