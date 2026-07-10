import { describe, it, expect, beforeEach } from "vitest";
import type { SessionLog } from "../bindings";
import { queryClient, queryKeys } from "../query";
import {
  createMockStep,
  createMockStepExecution,
  createMockTask,
  createMockTaskRun,
  createMockWorkflow,
} from "../test/test-utils";
import { useChatStore } from "./chatStore";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "./projectScopedStores";
import { useSessionLogStore } from "./sessionLogStore";
import { useWorkflowSelectionStore } from "./workflowSelectionStore";

describe("resetProjectScopedStores", () => {
  beforeEach(() => {
    resetProjectScopedStores();
  });

  it("clears query cache, run, log, and local chat state from the previous project", () => {
    const task = createMockTask({ id: "task-1" });
    const workflowId = "workflow-1";
    const workflow = createMockWorkflow({ id: workflowId });
    const step = createMockStep({ id: "step-1", workflow_id: workflowId });
    const execution = createMockStepExecution({
      id: "execution-1",
      task_id: task.id,
      workflow_id: workflowId,
    });
    const taskRun = createMockTaskRun({ id: "run-1", task_id: task.id });
    const sessionLog: SessionLog = {
      id: "log-1",
      step_execution_id: execution.id ?? undefined,
      content: "old project log",
      created_at: new Date().toISOString(),
    };
    const generation = getProjectScopeGeneration();
    const taskListKey = queryKeys.tasks.list(generation, null);
    const taskDetailKey = queryKeys.tasks.detail(generation, task.id);
    const executionsByTaskKey = queryKeys.executions.byTask(
      generation,
      task.id
    );
    const workflowListKey = queryKeys.workflows.list(generation);
    const workflowDetailKey = queryKeys.workflows.detail(
      generation,
      workflowId
    );
    queryClient.setQueryData(taskListKey, [task]);
    queryClient.setQueryData(taskDetailKey, task);
    queryClient.setQueryData(executionsByTaskKey, [execution]);
    queryClient.setQueryData(workflowListKey, [workflow]);
    queryClient.setQueryData(workflowDetailKey, { workflow, tasks: [task] });
    queryClient.setQueryData(queryKeys.steps.byId(generation, step.id!), step);
    useWorkflowSelectionStore.setState({
      selectedStepId: step.id,
      selectedWorkflowId: workflowId,
    });
    queryClient.setQueryData(queryKeys.taskRuns.byTask(generation, task.id), [
      taskRun,
    ]);
    useSessionLogStore.setState({
      logsByExecutionId: { [execution.id ?? "execution-1"]: [sessionLog] },
    });
    useChatStore.setState({
      sessions: {
        "chat-1": {
          id: "chat-1",
          label: "Old task",
          messages: [],
          status: "open",
          harness: "claude",
          backendSessionId: "claude-1",
          providerResumeId: null,
        },
      },
      activeSessionId: "chat-1",
      panelOpen: true,
    });
    resetProjectScopedStores();

    expect(queryClient.getQueryData(taskListKey)).toBeUndefined();
    expect(queryClient.getQueryData(taskDetailKey)).toBeUndefined();
    expect(queryClient.getQueryData(executionsByTaskKey)).toBeUndefined();
    expect(queryClient.getQueryData(workflowListKey)).toBeUndefined();
    expect(queryClient.getQueryData(workflowDetailKey)).toBeUndefined();
    expect(
      queryClient.getQueryData(queryKeys.steps.byId(generation, step.id!))
    ).toBeUndefined();
    expect(useWorkflowSelectionStore.getState()).toMatchObject({
      selectedStepId: null,
      selectedWorkflowId: null,
    });
    expect(
      queryClient.getQueryData(queryKeys.taskRuns.byTask(generation, task.id))
    ).toBeUndefined();
    expect(useSessionLogStore.getState().logsByExecutionId).toEqual({});
    expect(useChatStore.getState()).toMatchObject({
      sessions: {},
      activeSessionId: null,
      panelOpen: false,
    });
  });
});
