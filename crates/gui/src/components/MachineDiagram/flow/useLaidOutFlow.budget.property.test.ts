/**
 * Property test of the auto-layout budget in `useLaidOutFlow`. Hegel draws a
 * budget, how long the request waits behind other diagrams before layout
 * starts, how long layout then takes, and whether the caller goes away
 * first. On a fake clock, the hook must:
 *
 * - stay pending until layout has run for min(duration, budget), however
 *   long it queued: time spent waiting never counts against the budget;
 * - show the laid-out picture when layout finishes within the budget, and
 *   otherwise the row fallback with a timing message, abandoning the
 *   request (its signal aborts) so the shared worker moves on;
 * - ignore a layout that arrives after the budget ran out;
 * - abandon the request and leave no timer behind when the caller unmounts.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  compileFlowOrThrow,
  layoutFlow,
  type FlowLayout,
  type FlowSpec,
} from "./index";

interface Held {
  readonly signal?: AbortSignal;
  readonly start: () => void;
  readonly resolve: (layout: FlowLayout) => void;
}
const requests: Held[] = [];

vi.mock("./layoutClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./layoutClient")>();
  return {
    ...actual,
    layoutFlowOffThread: (
      _flow: unknown,
      o: { signal?: AbortSignal; onStart?: () => void } = {}
    ) =>
      new Promise((resolve, reject) => {
        o.signal?.addEventListener("abort", () =>
          reject(new actual.LayoutAbortedError())
        );
        requests.push({
          signal: o.signal,
          start: () => o.onStart?.(),
          resolve,
        });
      }),
  };
});

const { useLaidOutFlow } = await import("./useLaidOutFlow");

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const unplaced: FlowSpec = {
  version: 1,
  parts: [
    { id: "a", kind: "worker" },
    { id: "b", kind: "store" },
  ],
  rails: [{ id: "r", from: "b.out", to: "a.in" }],
};
const layout = await layoutFlow(compileFlowOrThrow(unplaced), { cache: false });

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

test(
  "the layout budget counts layout time only, and settles exactly as the clock says",
  () =>
    hegel.testAsync(
      async (tc) => {
        const budget = tc.draw(gs.integers({ minValue: 50, maxValue: 5_000 }));
        const queued = tc.draw(
          gs.integers({ minValue: 0, maxValue: 3 * budget })
        );
        // Keep clear of the exact budget: the boundary itself is a race.
        const duration = tc.draw(
          gs
            .integers({ minValue: 1, maxValue: 2 * budget })
            .filter((d) => Math.abs(d - budget) > 2)
        );
        // When the caller leaves, if it does: before or after layout starts.
        const leaves = tc.draw(
          gs.oneOf(
            gs.just(null),
            gs.integers({ minValue: 0, maxValue: queued + 2 * budget })
          )
        );
        vi.useFakeTimers();
        requests.length = 0;
        cleanup();
        const hook = renderHook(() =>
          useLaidOutFlow(unplaced, { budgetMs: budget })
        );
        check(requests.length === 1, `${requests.length} layout requests`);
        const [r] = requests;
        const startAt = queued;
        const endAt = startAt + Math.min(duration, budget);
        const gone = leaves !== null && leaves < endAt;

        if (gone && leaves! < startAt) {
          await advance(leaves!);
          hook.unmount();
        } else {
          await advance(startAt);
          check(
            hook.result.current.status === "pending",
            "settled before layout started"
          );
          r.start();
          if (gone) {
            await advance(leaves! - startAt);
            check(
              hook.result.current.status === "pending",
              "settled before its time"
            );
            hook.unmount();
          }
        }
        if (gone) {
          check(
            r.signal?.aborted === true,
            "unmounting did not abandon the request"
          );
          check(vi.getTimerCount() === 0, "a timer outlived the caller");
          return;
        }

        // Just before the end, still pending.
        await advance(Math.min(duration, budget) - 1);
        check(
          hook.result.current.status === "pending",
          `settled ${Math.min(duration, budget) - 1} ms into layout (budget ${budget}, layout ${duration}, queued ${queued})`
        );
        const inTime = duration < budget;
        if (inTime) await act(async () => r.resolve(layout));
        await advance(1);
        const state = hook.result.current;
        check(state.status === "done", "never settled");
        if (state.status !== "done") return;
        check(state.result.ok, "the result is not a compiled flow");
        if (inTime) {
          check(
            state.fallbackError === undefined,
            `fell back: ${state.fallbackError}`
          );
          check(r.signal?.aborted !== true, "a finished layout was abandoned");
          check(
            state.result.ok &&
              state.result.flow.arrangements[0].parts.every(
                (p) => p.position.x === layout.positions[p.id]?.x
              ),
            "the layout was not applied"
          );
        } else {
          check(
            /longer than/.test(state.fallbackError ?? ""),
            `timed out without saying so: ${state.fallbackError}`
          );
          check(
            r.signal?.aborted === true,
            "a timed-out request kept the worker"
          );
          // A layout arriving after the budget is ignored.
          await act(async () => r.resolve(layout));
          check(
            hook.result.current === state,
            "a late layout replaced the fallback"
          );
        }
        check(vi.getTimerCount() === 0, "a budget timer outlived the layout");
      },
      { testCases: 60 }
    ),
  120_000
);
