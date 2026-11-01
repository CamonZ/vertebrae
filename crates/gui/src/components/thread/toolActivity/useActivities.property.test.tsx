import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { useActivities } from "./useActivities";
import type { ActivityAnalysis, ActivityInput } from "./types";
import type { ToolMessage } from "../types";

class ScheduledWorker {
  static instances: ScheduledWorker[] = [];
  onmessage?: (event: {
    data: { kind: "result"; id: number; analysis: ActivityAnalysis };
  }) => void;
  onerror?: () => void;
  requests: { id: number; call: ActivityInput }[] = [];
  terminated = false;
  constructor() {
    ScheduledWorker.instances.push(this);
  }
  postMessage(request: { id: number; call: ActivityInput }) {
    this.requests.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  // Deliberately allow delivery after termination to exercise queued stale events.
  deliver(index: number) {
    const request = this.requests[index];
    const source = String(request.call.input.cmd);
    this.onmessage?.({
      data: {
        kind: "result",
        id: request.id,
        analysis: {
          operations: [
            { source, activities: [`submitted:${source}`], relationships: [] },
          ],
        },
      },
    });
  }
}
function call(
  source: string,
  status: ToolMessage["status"] = "pending",
  result?: string
): ToolMessage {
  return {
    type: "tool",
    evt: source,
    status,
    error: status === "err",
    recordedResult: result,
    activityInput: { name: "exec_command", input: { cmd: source } },
  };
}
type Owner = {
  source: string;
  hook: RenderHookResult<ActivityAnalysis[], { call: ToolMessage }>;
};

test(
  "generated response, replacement, failure and unmount schedules cannot cross owners or scopes",
  () =>
    hegel.testAsync(
      async (tc) => {
        const actions = tc.draw(
          gs.arrays(
            gs.record({
              kind: gs.sampledFrom([
                "mount",
                "replace",
                "unmount",
                "deliver",
                "error",
                "status",
              ] as const),
              slot: gs.integers({ minValue: 0, maxValue: 2 }),
              worker: gs.integers({ minValue: 0, maxValue: 20 }),
              request: gs.integers({ minValue: 0, maxValue: 20 }),
            }),
            { minSize: 1, maxSize: 25 }
          )
        );
        ScheduledWorker.instances = [];
        vi.stubGlobal("Worker", ScheduledWorker);
        const owners = new Map<number, Owner>();
        let revision = 0;
        const mount = (slot: number) => {
          const source = `owner-${slot}-revision-${revision++}`;
          const hook = renderHook(({ call }) => useActivities([call]), {
            initialProps: { call: call(source) },
          });
          owners.set(slot, { source, hook });
        };
        const assertIsolation = () => {
          for (const owner of owners.values())
            for (const operation of owner.hook.result.current[0].operations) {
              if (operation.activities[0]) {
                expect(operation.activities[0]).toBe(
                  `submitted:${owner.source}`
                );
                expect(operation.source).toBe(owner.source);
              } else expect(operation.unresolved).toBeTruthy();
            }
        };
        try {
          mount(0);
          mount(1);
          for (const action of actions) {
            const owner = owners.get(action.slot);
            await act(async () => {
              if (action.kind === "mount" && !owner) mount(action.slot);
              if (action.kind === "unmount" && owner) {
                owner.hook.unmount();
                owners.delete(action.slot);
              }
              if (action.kind === "replace" && owner) {
                owner.source = `owner-${action.slot}-revision-${revision++}`;
                owner.hook.rerender({ call: call(owner.source) });
              }
              if (action.kind === "status" && owner)
                owner.hook.rerender({
                  call: call(owner.source, "err", "process exited"),
                });
              const workers = ScheduledWorker.instances;
              const worker = workers[action.worker % workers.length];
              if (action.kind === "deliver" && worker?.requests.length)
                worker.deliver(action.request % worker.requests.length);
              if (action.kind === "error") worker?.onerror?.();
            });
            assertIsolation();
          }
          // Force fresh current requests, then deliver the whole transport history in reverse.
          if (!owners.size) mount(0);
          await act(async () => {
            for (const [slot, owner] of owners) {
              owner.source = `owner-${slot}-final-${revision++}`;
              owner.hook.rerender({ call: call(owner.source) });
            }
          });
          await act(async () => {
            for (const worker of [...ScheduledWorker.instances].reverse()) {
              for (let i = worker.requests.length - 1; i >= 0; i--)
                worker.deliver(i);
            }
          });
          assertIsolation();
          for (const owner of owners.values())
            expect(
              owner.hook.result.current[0].operations[0].activities[0]
            ).toBe(`submitted:${owner.source}`);
        } finally {
          for (const owner of owners.values()) owner.hook.unmount();
          expect(ScheduledWorker.instances.every((w) => w.terminated)).toBe(
            true
          );
          vi.unstubAllGlobals();
        }
      },
      { testCases: 60 }
    ),
  15000
);

test(
  "generated status/result updates neither reclassify nor change submitted activities",
  () =>
    hegel.testAsync(
      async (tc) => {
        const updates = tc.draw(
          gs.arrays(
            gs.record({
              status: gs.sampledFrom([
                "pending",
                "ok",
                "done",
                "err",
                undefined,
              ] as const),
              output: gs.text({ maxSize: 80 }),
            }),
            { minSize: 1, maxSize: 25 }
          )
        );
        ScheduledWorker.instances = [];
        vi.stubGlobal("Worker", ScheduledWorker);
        const hook = renderHook(({ call }) => useActivities([call]), {
          initialProps: { call: call("cargo test") },
        });
        try {
          await act(async () => ScheduledWorker.instances[0].deliver(0));
          const original = hook.result.current;
          const requestCount = () =>
            ScheduledWorker.instances.reduce(
              (total, w) => total + w.requests.length,
              0
            );
          expect(requestCount()).toBe(1);
          for (const update of updates) {
            await act(async () =>
              hook.rerender({
                call: {
                  ...call("cargo test", update.status, update.output),
                  status: update.status,
                },
              })
            );
            expect(hook.result.current).toEqual(original);
            expect(requestCount()).toBe(1);
            expect(hook.result.current[0].operations[0].activities[0]).toBe(
              "submitted:cargo test"
            );
          }
        } finally {
          hook.unmount();
          vi.unstubAllGlobals();
        }
      },
      { testCases: 60 }
    ),
  15000
);
