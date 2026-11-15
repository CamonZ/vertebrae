import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { FlowSpec } from "./index";

const signals: AbortSignal[] = [];
/** Starts held requests, as the worker would when it reaches them. */
const held: (() => void)[] = [];
let holdStart = false;

// A layout that never finishes on its own, so only the budget or the caller
// can end it.
vi.mock("./layoutClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./layoutClient")>();
  return {
    ...actual,
    layoutFlowOffThread: (
      _flow: unknown,
      o: { signal?: AbortSignal; onStart?: () => void } = {}
    ) =>
      new Promise((_, reject) => {
        if (o.signal) signals.push(o.signal);
        o.signal?.addEventListener("abort", () =>
          reject(new actual.LayoutAbortedError())
        );
        if (holdStart) held.push(() => o.onStart?.());
        else o.onStart?.();
      }),
  };
});

const { useLaidOutFlow } = await import("./useLaidOutFlow");

afterEach(() => {
  cleanup();
  signals.length = 0;
  held.length = 0;
  holdStart = false;
});

const unplaced: FlowSpec = {
  version: 1,
  parts: [
    { id: "a", kind: "worker" },
    { id: "b", kind: "store" },
  ],
  rails: [{ id: "r", from: "b.out", to: "a.in" }],
};

test("falls back to the row layout when auto-layout exceeds its budget", async () => {
  const { result } = renderHook(() =>
    useLaidOutFlow(unplaced, { budgetMs: 20 })
  );
  expect(result.current.status).toBe("pending");
  await waitFor(() => expect(result.current.status).toBe("done"));
  const state = result.current;
  expect(state.status === "done" && state.result.ok).toBe(true);
  expect(state.status === "done" && state.fallbackError).toMatch(
    /longer than .*\(queued .*, layout .*\)/
  );
  expect(signals[0].aborted).toBe(true);
});

test("abandons the layout request when the caller unmounts", () => {
  const { unmount } = renderHook(() =>
    useLaidOutFlow(unplaced, { budgetMs: 60_000 })
  );
  expect(signals[0].aborted).toBe(false);
  unmount();
  expect(signals[0].aborted).toBe(true);
});

test("time spent queued behind other layouts does not count against the budget", async () => {
  holdStart = true;
  const { result } = renderHook(() =>
    useLaidOutFlow(unplaced, { budgetMs: 20 })
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(result.current.status).toBe("pending");
  expect(signals[0].aborted).toBe(false);
  held.forEach((start) => start());
  await waitFor(() => expect(result.current.status).toBe("done"));
  expect(signals[0].aborted).toBe(true);
});
