import { describe, it, expect, beforeEach } from "vitest";
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

describe("sessionLogStore", () => {
  beforeEach(() => {
    useSessionLogStore.setState({ logsByExecutionId: {} });
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

      const state = useSessionLogStore.getState();
      expect(state.logsByExecutionId["exec-1"]).toHaveLength(2);
      expect(state.logsByExecutionId["exec-1"][0].id).toBe("log-1");
      expect(state.logsByExecutionId["exec-1"][0].content).toBe("first");
      expect(state.logsByExecutionId["exec-1"][1].id).toBe("log-2");
      expect(state.logsByExecutionId["exec-1"][1].content).toBe("second");
    });

    it("replaces existing logs for the same execution ID", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [createMockSessionLog({ id: "log-1", content: "old" })]);

      useSessionLogStore
        .getState()
        .setLogs("exec-1", [createMockSessionLog({ id: "log-2", content: "new" })]);

      const state = useSessionLogStore.getState();
      expect(state.logsByExecutionId["exec-1"]).toHaveLength(1);
      expect(state.logsByExecutionId["exec-1"][0].id).toBe("log-2");
      expect(state.logsByExecutionId["exec-1"][0].content).toBe("new");
    });

    it("does not affect other execution IDs", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [createMockSessionLog({ id: "log-1", content: "exec-1 log" })]);

      useSessionLogStore
        .getState()
        .setLogs("exec-2", [createMockSessionLog({ id: "log-2", content: "exec-2 log" })]);

      const state = useSessionLogStore.getState();
      expect(state.logsByExecutionId["exec-1"]).toHaveLength(1);
      expect(state.logsByExecutionId["exec-1"][0].id).toBe("log-1");
      expect(state.logsByExecutionId["exec-1"][0].content).toBe("exec-1 log");
      expect(state.logsByExecutionId["exec-2"]).toHaveLength(1);
      expect(state.logsByExecutionId["exec-2"][0].id).toBe("log-2");
      expect(state.logsByExecutionId["exec-2"][0].content).toBe("exec-2 log");
    });
  });

  describe("appendLog", () => {
    it("appends to existing bucket", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [createMockSessionLog({ id: "log-1", content: "first" })]);

      useSessionLogStore
        .getState()
        .appendLog("exec-1", createMockSessionLog({ id: "log-2", content: "second" }));

      const state = useSessionLogStore.getState();
      expect(state.logsByExecutionId["exec-1"]).toHaveLength(2);
      expect(state.logsByExecutionId["exec-1"][0].id).toBe("log-1");
      expect(state.logsByExecutionId["exec-1"][0].content).toBe("first");
      expect(state.logsByExecutionId["exec-1"][1].id).toBe("log-2");
      expect(state.logsByExecutionId["exec-1"][1].content).toBe("second");
    });

    it("creates new bucket when execution ID does not exist", () => {
      useSessionLogStore
        .getState()
        .appendLog("exec-new", createMockSessionLog({ id: "log-1", content: "brand new" }));

      const state = useSessionLogStore.getState();
      expect(state.logsByExecutionId["exec-new"]).toHaveLength(1);
      expect(state.logsByExecutionId["exec-new"][0].id).toBe("log-1");
      expect(state.logsByExecutionId["exec-new"][0].content).toBe("brand new");
    });

    it("does not append a log whose id is already in the execution bucket", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [createMockSessionLog({ id: "log-1", content: "first copy" })]);

      useSessionLogStore
        .getState()
        .appendLog("exec-1", createMockSessionLog({ id: "log-1", content: "replayed copy" }));

      const logs = useSessionLogStore.getState().logsByExecutionId["exec-1"];
      expect(logs).toHaveLength(1);
      expect(logs[0].id).toBe("log-1");
      expect(logs[0].content).toBe("first copy");
    });

    it("does not affect other execution IDs", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [createMockSessionLog({ id: "log-1", content: "exec-1 log" })]);
      useSessionLogStore
        .getState()
        .setLogs("exec-2", [createMockSessionLog({ id: "log-2", content: "exec-2 log" })]);

      useSessionLogStore
        .getState()
        .appendLog("exec-1", createMockSessionLog({ id: "log-3", content: "appended" }));

      const state = useSessionLogStore.getState();
      expect(state.logsByExecutionId["exec-1"]).toHaveLength(2);
      expect(state.logsByExecutionId["exec-2"]).toHaveLength(1);
      expect(state.logsByExecutionId["exec-2"][0].id).toBe("log-2");
      expect(state.logsByExecutionId["exec-2"][0].content).toBe("exec-2 log");
    });
  });

  describe("upsertLog", () => {
    it("replaces an existing log by id without growing or reordering", () => {
      useSessionLogStore.getState().setLogs("exec-1", [
        createMockSessionLog({ id: "log-1", content: "first" }),
        createMockSessionLog({ id: "log-2", content: "second" }),
      ]);

      useSessionLogStore
        .getState()
        .upsertLog("exec-1", createMockSessionLog({ id: "log-1", content: "updated" }));

      const logs = useSessionLogStore.getState().logsByExecutionId["exec-1"];
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

      const logs = useSessionLogStore.getState().logsByExecutionId["exec-1"];
      expect(logs).toHaveLength(2);
      expect(logs[0].id).toBe("new-id");
      expect(logs[0].content).toBe("new snapshot");
      expect(logs[1].id).toBe("durable-id");
    });

    it("inserts when the log is absent", () => {
      useSessionLogStore
        .getState()
        .upsertLog("exec-new", createMockSessionLog({ id: "log-1", content: "first update" }));

      const logs = useSessionLogStore.getState().logsByExecutionId["exec-new"];
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

      const logs = useSessionLogStore.getState().logsByExecutionId["exec-1"];
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
          log: createMockSessionLog({ id: "after-reconnect", content: "new row" }),
        },
      ]);

      const logs = useSessionLogStore.getState().logsByExecutionId["exec-1"];
      expect(logs.map(({ id, content }) => ({ id, content }))).toEqual([
        { id: "ephemeral-new", content: "new snapshot" },
        { id: "durable", content: "durable row" },
        { id: "after-reconnect", content: "new row" },
      ]);
    });

    it("preserves untouched execution bucket references for duplicate-only entries", () => {
      const unchanged = [createMockSessionLog({ id: "log-2", content: "untouched" })];
      useSessionLogStore.getState().setLogs("exec-1", [
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
        .setLogs("exec-1", [createMockSessionLog({ id: "log-1", content: "exec-1 log" })]);
      useSessionLogStore
        .getState()
        .setLogs("exec-2", [createMockSessionLog({ id: "log-2", content: "exec-2 log" })]);

      useSessionLogStore.getState().clearLogs("exec-1");

      const state = useSessionLogStore.getState();
      expect(state.logsByExecutionId["exec-1"]).toBeUndefined();
      expect(state.logsByExecutionId["exec-2"]).toHaveLength(1);
      expect(state.logsByExecutionId["exec-2"][0].id).toBe("log-2");
      expect(state.logsByExecutionId["exec-2"][0].content).toBe("exec-2 log");
    });

    it("is a no-op for non-existent execution ID", () => {
      useSessionLogStore
        .getState()
        .setLogs("exec-1", [createMockSessionLog({ id: "log-1" })]);

      useSessionLogStore.getState().clearLogs("exec-nonexistent");

      const state = useSessionLogStore.getState();
      expect(state.logsByExecutionId["exec-1"]).toHaveLength(1);
      expect(state.logsByExecutionId["exec-1"][0].id).toBe("log-1");
      expect(state.logsByExecutionId["exec-nonexistent"]).toBeUndefined();
    });
  });
});
