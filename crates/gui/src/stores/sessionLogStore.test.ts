import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useSessionLogStore } from "./sessionLogStore";
import type { SessionLog } from "../bindings";

function createMockSessionLog(overrides?: Partial<SessionLog>): SessionLog {
  return {
    id: "log-1",
    step_execution_id: "exec-1",
    content: "Some log content",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function createSessionEndLog(
  id: string,
  costUsd: number,
  logical_key?: string
): SessionLog {
  return createMockSessionLog({
    id,
    logical_key,
    format: "harness",
    content: JSON.stringify({
      version: 1,
      event_id: `event-${id}`,
      stream_id: "stream-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      semantics: "snapshot",
      type: "run_finished",
      data: {
        status: "completed",
        metrics: { total_cost_usd: costUsd },
      },
    }),
  });
}

function logsFor(executionId: string): SessionLog[] {
  return (
    useSessionLogStore.getState().logsByExecutionId[executionId]?.logs ?? []
  );
}

describe("sessionLogStore", () => {
  beforeEach(() => {
    useSessionLogStore.getState().reset();
  });

  afterEach(() => {
    useSessionLogStore.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("initial state", () => {
    it("has empty logsByExecutionId", () => {
      expect(useSessionLogStore.getState().logsByExecutionId).toEqual({});
    });
  });

  describe("setLogs", () => {
    it("sets logs for an execution ID", () => {
      const logs = [
        createMockSessionLog({ id: "log-1", content: "first" }),
        createMockSessionLog({ id: "log-2", content: "second" }),
      ];

      useSessionLogStore.getState().setLogs("exec-1", logs);

      expect(logsFor("exec-1")).toHaveLength(2);
      expect(logsFor("exec-1")[0].id).toBe("log-1");
      expect(logsFor("exec-1")[0].content).toBe("first");
      expect(logsFor("exec-1")[1].id).toBe("log-2");
      expect(logsFor("exec-1")[1].content).toBe("second");
    });

    it("replaces existing logs for the same execution ID", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [
          createMockSessionLog({ id: "log-1", content: "old" }),
        ]);

      useSessionLogStore
        .getState()
        .setLogs("exec-1", [
          createMockSessionLog({ id: "log-2", content: "new" }),
        ]);

      expect(logsFor("exec-1")).toHaveLength(1);
      expect(logsFor("exec-1")[0].id).toBe("log-2");
      expect(logsFor("exec-1")[0].content).toBe("new");
    });

    it("does not affect other execution IDs", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [
          createMockSessionLog({ id: "log-1", content: "exec-1 log" }),
        ]);

      useSessionLogStore
        .getState()
        .setLogs("exec-2", [
          createMockSessionLog({ id: "log-2", content: "exec-2 log" }),
        ]);

      expect(logsFor("exec-1")).toHaveLength(1);
      expect(logsFor("exec-1")[0].id).toBe("log-1");
      expect(logsFor("exec-1")[0].content).toBe("exec-1 log");
      expect(logsFor("exec-2")).toHaveLength(1);
      expect(logsFor("exec-2")[0].id).toBe("log-2");
      expect(logsFor("exec-2")[0].content).toBe("exec-2 log");
    });
  });

  describe("appendLog", () => {
    it("applies queued records in batches of at most 256", () => {
      const notificationSizes: number[] = [];
      const unsubscribe = useSessionLogStore.subscribe((state) => {
        notificationSizes.push(
          state.logsByExecutionId["exec-1"]?.logs.length ?? 0
        );
      });

      for (let index = 0; index < 600; index += 1) {
        useSessionLogStore
          .getState()
          .appendLog("exec-1", createMockSessionLog({ id: `log-${index}` }));
      }

      expect(logsFor("exec-1")).toHaveLength(0);
      useSessionLogStore.getState().flushPending();
      expect(logsFor("exec-1")).toHaveLength(256);
      useSessionLogStore.getState().flushPending();
      expect(logsFor("exec-1")).toHaveLength(512);
      useSessionLogStore.getState().flushPending();
      expect(logsFor("exec-1")).toHaveLength(600);

      unsubscribe();
      expect(notificationSizes).toEqual([256, 512, 600]);
    });

    it("uses the timer fallback when animation frames are unavailable", () => {
      vi.useFakeTimers();
      vi.stubGlobal("requestAnimationFrame", undefined);

      useSessionLogStore
        .getState()
        .appendLog("exec-timer", createMockSessionLog({ id: "timer-log" }));

      vi.advanceTimersByTime(49);
      expect(logsFor("exec-timer")).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(logsFor("exec-timer")).toHaveLength(1);
    });

    it("appends to existing bucket", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [
          createMockSessionLog({ id: "log-1", content: "first" }),
        ]);

      useSessionLogStore
        .getState()
        .appendLog(
          "exec-1",
          createMockSessionLog({ id: "log-2", content: "second" })
        );
      useSessionLogStore.getState().flushPending();

      expect(logsFor("exec-1")).toHaveLength(2);
      expect(logsFor("exec-1")[0].id).toBe("log-1");
      expect(logsFor("exec-1")[0].content).toBe("first");
      expect(logsFor("exec-1")[1].id).toBe("log-2");
      expect(logsFor("exec-1")[1].content).toBe("second");
    });

    it("creates new bucket when execution ID does not exist", () => {
      useSessionLogStore
        .getState()
        .appendLog(
          "exec-new",
          createMockSessionLog({ id: "log-1", content: "brand new" })
        );
      useSessionLogStore.getState().flushPending();

      expect(logsFor("exec-new")).toHaveLength(1);
      expect(logsFor("exec-new")[0].id).toBe("log-1");
      expect(logsFor("exec-new")[0].content).toBe("brand new");
    });

    it("does not append a log whose id is already in the execution bucket", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [
          createMockSessionLog({ id: "log-1", content: "first copy" }),
        ]);

      useSessionLogStore
        .getState()
        .appendLog(
          "exec-1",
          createMockSessionLog({ id: "log-1", content: "replayed copy" })
        );
      useSessionLogStore.getState().flushPending();

      const logs = logsFor("exec-1");
      expect(logs).toHaveLength(1);
      expect(logs[0].id).toBe("log-1");
      expect(logs[0].content).toBe("first copy");
    });

    it("does not affect other execution IDs", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [
          createMockSessionLog({ id: "log-1", content: "exec-1 log" }),
        ]);
      useSessionLogStore
        .getState()
        .setLogs("exec-2", [
          createMockSessionLog({ id: "log-2", content: "exec-2 log" }),
        ]);

      useSessionLogStore
        .getState()
        .appendLog(
          "exec-1",
          createMockSessionLog({ id: "log-3", content: "appended" })
        );
      useSessionLogStore.getState().flushPending();

      expect(logsFor("exec-1")).toHaveLength(2);
      expect(logsFor("exec-2")).toHaveLength(1);
      expect(logsFor("exec-2")[0].id).toBe("log-2");
      expect(logsFor("exec-2")[0].content).toBe("exec-2 log");
    });
  });

  describe("upsertLog", () => {
    it("replaces an existing log by id without growing or reordering", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [
          createMockSessionLog({ id: "log-1", content: "first" }),
          createMockSessionLog({ id: "log-2", content: "second" }),
        ]);

      useSessionLogStore
        .getState()
        .upsertLog(
          "exec-1",
          createMockSessionLog({ id: "log-1", content: "updated" })
        );
      useSessionLogStore.getState().flushPending();

      const logs = logsFor("exec-1");
      expect(logs).toHaveLength(2);
      expect(logs[0].id).toBe("log-1");
      expect(logs[0].content).toBe("updated");
      expect(logs[1].id).toBe("log-2");
      expect(logs[1].content).toBe("second");
    });

    it("replaces an existing log by logical_key without growing or reordering", () => {
      useSessionLogStore.getState().setLogs("exec-1", [
        createMockSessionLog({
          id: "old-id",
          logical_key: "thinking:sess-1",
          content: "old snapshot",
        }),
        createMockSessionLog({ id: "durable-id", content: "durable" }),
      ]);

      useSessionLogStore.getState().upsertLog(
        "exec-1",
        createMockSessionLog({
          id: "new-id",
          logical_key: "thinking:sess-1",
          content: "new snapshot",
        })
      );
      useSessionLogStore.getState().flushPending();

      const logs = logsFor("exec-1");
      expect(logs).toHaveLength(2);
      expect(logs[0].id).toBe("new-id");
      expect(logs[0].content).toBe("new snapshot");
      expect(logs[1].id).toBe("durable-id");
    });

    it("inserts when the log is absent", () => {
      useSessionLogStore
        .getState()
        .upsertLog(
          "exec-new",
          createMockSessionLog({ id: "log-1", content: "first update" })
        );
      useSessionLogStore.getState().flushPending();

      const logs = logsFor("exec-new");
      expect(logs).toHaveLength(1);
      expect(logs[0].id).toBe("log-1");
      expect(logs[0].content).toBe("first update");
    });
  });

  describe("applyLogBatch", () => {
    it("applies ordered appends and updates with one store notification", () => {
      const notifications: string[][] = [];
      const unsubscribe = useSessionLogStore.subscribe((state) => {
        notifications.push(Object.keys(state.logsByExecutionId));
      });

      useSessionLogStore.getState().applyLogBatch([
        {
          executionId: "exec-1",
          operation: "append",
          log: createMockSessionLog({ id: "log-1", content: "first" }),
        },
        {
          executionId: "exec-1",
          operation: "append",
          log: createMockSessionLog({ id: "log-2", content: "second" }),
        },
        {
          executionId: "exec-1",
          operation: "upsert",
          log: createMockSessionLog({ id: "log-1", content: "corrected" }),
        },
      ]);

      unsubscribe();

      const logs = logsFor("exec-1");
      expect(notifications).toHaveLength(1);
      expect(logs.map(({ id, content }) => ({ id, content }))).toEqual([
        { id: "log-1", content: "corrected" },
        { id: "log-2", content: "second" },
      ]);
    });

    it("deduplicates replayed appends and reconciles logical-key updates in order", () => {
      const existing = [
        createMockSessionLog({
          id: "ephemeral-old",
          logical_key: "thinking:1",
          content: "old snapshot",
        }),
        createMockSessionLog({ id: "durable", content: "durable row" }),
      ];
      useSessionLogStore.getState().setLogs("exec-1", existing);

      useSessionLogStore.getState().applyLogBatch([
        {
          executionId: "exec-1",
          operation: "append",
          log: createMockSessionLog({ id: "durable", content: "replayed row" }),
        },
        {
          executionId: "exec-1",
          operation: "upsert",
          log: createMockSessionLog({
            id: "ephemeral-new",
            logical_key: "thinking:1",
            content: "new snapshot",
          }),
        },
        {
          executionId: "exec-1",
          operation: "append",
          log: createMockSessionLog({
            id: "after-reconnect",
            content: "new row",
          }),
        },
      ]);

      const logs = logsFor("exec-1");
      expect(logs.map(({ id, content }) => ({ id, content }))).toEqual([
        { id: "ephemeral-new", content: "new snapshot" },
        { id: "durable", content: "durable row" },
        { id: "after-reconnect", content: "new row" },
      ]);
    });

    it("preserves untouched execution bucket references for duplicate-only entries", () => {
      const unchanged = [
        createMockSessionLog({ id: "log-2", content: "untouched" }),
      ];
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [
          createMockSessionLog({ id: "log-1", content: "existing" }),
        ]);
      useSessionLogStore.getState().setLogs("exec-2", unchanged);
      const before = useSessionLogStore.getState().logsByExecutionId;

      useSessionLogStore.getState().applyLogBatch([
        {
          executionId: "exec-1",
          operation: "append",
          log: createMockSessionLog({ id: "log-1", content: "replayed" }),
        },
        {
          executionId: "exec-2",
          operation: "append",
          log: createMockSessionLog({ id: "log-2", content: "replayed" }),
        },
      ]);

      const after = useSessionLogStore.getState().logsByExecutionId;
      expect(after).toBe(before);
      expect(after["exec-1"]).toBe(before["exec-1"]);
      expect(after["exec-2"]).toBe(before["exec-2"]);
    });
  });

  describe("incremental fallback costs", () => {
    it("maintains fallback cost for appended and corrected records", () => {
      const baseline = createSessionEndLog("log-1", 0.1, "terminal");
      useSessionLogStore.getState().setLogs("exec-1", [baseline]);
      useSessionLogStore.getState().applyLogBatch([
        {
          executionId: "exec-1",
          operation: "append",
          log: createSessionEndLog("log-2", 0.2),
        },
        {
          executionId: "exec-1",
          operation: "append",
          log: createSessionEndLog("log-1", 0.9),
        },
        {
          executionId: "exec-1",
          operation: "upsert",
          log: createSessionEndLog("log-corrected", 0.3, "terminal"),
        },
      ]);

      expect(
        useSessionLogStore.getState().logsByExecutionId["exec-1"].fallbackCost
      ).toBeCloseTo(0.5, 10);
      expect(logsFor("exec-1").map(({ id }) => id)).toEqual([
        "log-corrected",
        "log-2",
      ]);
    });
  });

  describe("clearLogs", () => {
    it("removes logs for the given execution ID", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [createMockSessionLog({ id: "log-1" })]);

      useSessionLogStore.getState().clearLogs("exec-1");

      const state = useSessionLogStore.getState();
      expect(state.logsByExecutionId["exec-1"]).toBeUndefined();
      expect(Object.keys(state.logsByExecutionId)).toHaveLength(0);
    });

    it("does not affect other execution IDs", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [
          createMockSessionLog({ id: "log-1", content: "exec-1 log" }),
        ]);
      useSessionLogStore
        .getState()
        .setLogs("exec-2", [
          createMockSessionLog({ id: "log-2", content: "exec-2 log" }),
        ]);

      useSessionLogStore.getState().clearLogs("exec-1");

      const state = useSessionLogStore.getState();
      expect(state.logsByExecutionId["exec-1"]).toBeUndefined();
      expect(logsFor("exec-2")).toHaveLength(1);
      expect(logsFor("exec-2")[0].id).toBe("log-2");
      expect(logsFor("exec-2")[0].content).toBe("exec-2 log");
    });

    it("is a no-op for non-existent execution ID", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [createMockSessionLog({ id: "log-1" })]);

      useSessionLogStore.getState().clearLogs("exec-nonexistent");

      const state = useSessionLogStore.getState();
      expect(logsFor("exec-1")).toHaveLength(1);
      expect(logsFor("exec-1")[0].id).toBe("log-1");
      expect(state.logsByExecutionId["exec-nonexistent"]).toBeUndefined();
    });
  });

  it("drops pending records when the project-scoped store is reset", () => {
    useSessionLogStore
      .getState()
      .appendLog("stale-execution", createMockSessionLog({ id: "stale-log" }));

    useSessionLogStore.getState().reset();
    useSessionLogStore.getState().flushPending();

    expect(useSessionLogStore.getState().logsByExecutionId).toEqual({});
  });
});
