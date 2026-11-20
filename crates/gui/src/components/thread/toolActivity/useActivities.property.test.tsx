import { act, renderHook } from "@testing-library/react";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test, vi } from "vitest";
import { commands } from "../../../bindings";
import type { ToolMessage } from "../types";
import { useActivities } from "./useActivities";

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

test("generated response orders only publish the current batch", () =>
  hegel.testAsync(async (tc) => {
    const releases = tc.draw(
      gs.arrays(gs.integers({ minValue: 0, maxValue: 4 }), {
        minSize: 1,
        maxSize: 8,
      })
    );
    const analyze = vi.mocked(commands.analyzeToolActivities);
    analyze.mockReset();
    const requests = Array.from({ length: 5 }, () =>
      deferred<Awaited<ReturnType<typeof analyze>>>()
    );
    for (const request of requests)
      analyze.mockReturnValueOnce(request.promise);
    const calls = Array.from({ length: 5 }, (_, i): ToolMessage[] => [
      {
        evt: String(i),
        type: "tool",
        name: "exec_command",
        status: "done",
        activityInput: { name: "exec_command", input: { cmd: String(i) } },
      },
    ]);
    const view = renderHook(({ step }) => useActivities(calls[step]), {
      initialProps: { step: 0 },
    });
    try {
      for (let step = 1; step < calls.length; step++) view.rerender({ step });
      let activePublished = false;
      for (const index of releases) {
        await act(async () =>
          requests[index].resolve({
            status: "ok",
            data: [
              {
                operations: [
                  { source: String(index), activities: [], relationships: [] },
                ],
              },
            ],
          })
        );
        activePublished ||= index === calls.length - 1;
        if (activePublished) {
          expect(view.result.current[0].operations[0].source).toBe("4");
        } else {
          expect(view.result.current[0].analysisState).toBe("loading");
        }
      }
    } finally {
      view.unmount();
    }
  }));
