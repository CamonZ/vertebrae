import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStepExecution, createMockTaskRun } from "../test/test-utils";
import type { TaskRun } from "../bindings";
import { queryClient } from "../query";
import { useChatStore, isRunPane } from "../stores/chatStore";
import { useShellStore } from "../stores/shellStore";
import { openRunInChat, resolveTaskRunTarget } from "./openRunInChat";

let runs: TaskRun[] = [];
vi.mock("../bindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bindings")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getTaskRuns: vi.fn(async () => ({ status: "ok", data: runs })),
    },
  };
});

describe("openRunInChat", () => {
  beforeEach(() => {
    queryClient.clear();
    runs = [];
    useShellStore.getState().setChatPanelPresentation("compact");
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
    });
  });

  it("maximizes the chat and opens the run pane scrolled to a thread", () => {
    openRunInChat({ taskId: "t1", runId: "r1", threadId: "exec-1" });

    expect(useShellStore.getState().chatPanelPresentation).toBe("expanded");
    const pane = useChatStore.getState().paneLayout.panes[0];
    expect(isRunPane(pane) && pane.scrollRequest?.threadId).toBe("exec-1");
    expect(useChatStore.getState().panelOpen).toBe(true);
  });

  it("prefers the task's active run, then its newest run", async () => {
    runs = [
      createMockTaskRun({
        id: "old",
        status: "completed",
        started_at: "2026-01-01T00:00:00Z",
      }),
      createMockTaskRun({
        id: "new",
        status: "failed",
        started_at: "2026-01-03T00:00:00Z",
      }),
    ];
    expect(await resolveTaskRunTarget("t1")).toEqual({
      taskId: "t1",
      runId: "new",
    });

    queryClient.clear();
    runs = [
      ...runs,
      createMockTaskRun({
        id: "active",
        status: "waiting",
        started_at: "2026-01-02T00:00:00Z",
      }),
    ];
    expect(await resolveTaskRunTarget("t1")).toEqual({
      taskId: "t1",
      runId: "active",
    });
  });

  it("falls back to the newest subtree run when the task has none", async () => {
    const target = await resolveTaskRunTarget("parent", [
      createMockStepExecution({
        task_id: "child-a",
        task_run_id: "run-a",
        started_at: "2026-01-01T00:00:00Z",
      }),
      createMockStepExecution({
        task_id: "child-b",
        task_run_id: "run-b",
        started_at: "2026-01-02T00:00:00Z",
      }),
    ]);
    expect(target).toEqual({ taskId: "child-b", runId: "run-b" });
    expect(await resolveTaskRunTarget("parent")).toBeNull();
  });
});
