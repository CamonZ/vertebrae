import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useBackgroundTask } from "./useBackgroundTask";
import type { BackgroundTask } from "./types";
import type { BackgroundOutputs } from "./types";

type PatchResult = BackgroundOutputs["patch"];

const run = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ backgroundClient: { run } }));

const inline = vi.fn((): PatchResult => []);
const task: Extract<BackgroundTask, { kind: "patch" }> = {
  kind: "patch",
  patches: ["first"],
  review: false,
};

function deferred() {
  let resolve!: (value: PatchResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<PatchResult>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });

  return { promise, resolve, reject };
}

const result: PatchResult = [
  { files: [], reviewFiles: [{ oldPath: "a", newPath: "a", hunks: [] }] },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("retires old success/error results and cancels on unmount", async () => {
  vi.stubGlobal("Worker", class {});

  const first = deferred();
  const second = deferred();
  run.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

  const hook = renderHook(({ input }) => useBackgroundTask(input, inline), {
    initialProps: { input: task, scope: "a" },
  });
  const oldSignal: AbortSignal = run.mock.calls[0][1];

  hook.rerender({ input: { ...task, patches: ["second"] }, scope: "b" });
  expect(oldSignal.aborted).toBe(true);
  await act(async () => {
    first.reject(new Error("retired"));
    second.resolve(result);
  });

  expect(hook.result.current.value).toEqual(result);
  expect(hook.result.current.error).toBeUndefined();
  expect(inline).not.toHaveBeenCalled();

  hook.unmount();
  expect((run.mock.calls[1][1] as AbortSignal).aborted).toBe(true);
});

it("clears prepared results when the requested input changes", async () => {
  vi.stubGlobal("Worker", class {});

  const first = deferred();
  const second = deferred();
  run.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

  const hook = renderHook(({ input }) => useBackgroundTask(input, inline), {
    initialProps: { input: task },
  });
  await act(async () => first.resolve(result));

  hook.rerender({ input: { ...task, patches: ["updated"] } });
  expect(hook.result.current.value).toBeUndefined();
  expect(hook.result.current.pending).toBe(true);
  await act(async () => second.resolve([]));
  expect(hook.result.current.value).toEqual([]);
});

it("surfaces worker failure and retries without doing expensive work inline", async () => {
  vi.stubGlobal("Worker", class {});
  run.mockRejectedValueOnce(new Error("failed")).mockResolvedValueOnce(result);

  const hook = renderHook(() => useBackgroundTask(task, inline));
  await act(async () => {
    await Promise.resolve();
  });
  expect(hook.result.current.error).toBe("failed");

  await act(async () => hook.result.current.retry());
  expect(hook.result.current.value).toEqual(result);
  expect(inline).not.toHaveBeenCalled();
});

it("clears retained history immediately when its task is disabled", async () => {
  vi.stubGlobal("Worker", class {});
  run.mockResolvedValueOnce(result);

  const hook = renderHook(
    ({ enabled }) => useBackgroundTask(enabled ? task : null, inline),
    { initialProps: { enabled: true } }
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(hook.result.current.value).toEqual(result);

  hook.rerender({ enabled: false });
  expect(hook.result.current.value).toBeUndefined();
  expect(hook.result.current.pending).toBe(false);
});
