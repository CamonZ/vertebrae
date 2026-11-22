import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { TaskRun } from "../../bindings";
import { queryClient, queryKeys } from "../../query";
import { useChatStore, type ChatSession } from "../../stores/chatStore";
import type { ChatPane } from "../../stores/chatWorkspace";
import { getProjectScopeGeneration } from "../../stores/projectScopedStores";
import { chatsNeedingYou, useChatTabs } from "./useChatTabs";

const session = (id: string, overrides: Partial<ChatSession> = {}) =>
  ({
    id,
    label: id,
    title: `Chat ${id}`,
    messages: [],
    status: "open",
    harness: "claude",
    backendSessionId: null,
    providerResumeId: null,
    ...overrides,
  }) as ChatSession;

const run = (id: string, status: TaskRun["status"]) =>
  ({ id, task_id: "task-1", status }) as TaskRun;

afterEach(() => {
  queryClient.clear();
  useChatStore.setState({ sessions: {} });
});

function renderTabs(order: ChatPane[]) {
  return renderHook(() => {
    const tabs = useChatTabs(order, undefined);
    return { tabs, needingYou: chatsNeedingYou(tabs) };
  });
}

describe("useChatTabs", () => {
  it("counts a failed run as needing the user", () => {
    useChatStore.setState({ sessions: { a: session("a") } });
    queryClient.setQueryData(
      queryKeys.taskRuns.byTask(getProjectScopeGeneration(), "task-1"),
      [run("run-1", "failed")]
    );
    const order: ChatPane[] = [
      { id: "e-a", sessionId: "a" },
      { id: "e-run", kind: "run", taskId: "task-1", runId: "run-1" },
    ];

    const { result } = renderTabs(order);

    expect(result.current.tabs.map((tab) => tab.id)).toEqual(["e-a", "e-run"]);
    expect(result.current.tabs[1]).toMatchObject({
      isRun: true,
      attention: { state: "error" },
    });
    expect(result.current.needingYou).toEqual(["e-run"]);
  });

  it("keeps the tabs while streaming leaves every state unchanged", () => {
    useChatStore.setState({ sessions: { a: session("a") } });
    const order: ChatPane[] = [{ id: "e-a", sessionId: "a" }];
    const { result } = renderTabs(order);
    const before = result.current.tabs;

    useChatStore.setState((state) => ({
      sessions: { a: { ...state.sessions.a, messages: [] } },
    }));

    expect(result.current.tabs).toBe(before);
  });
});
