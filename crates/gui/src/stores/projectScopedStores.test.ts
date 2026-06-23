import { describe, it, expect, beforeEach } from "vitest";
import type { SessionLog } from "../bindings";
import {
  createMockStep,
  createMockStepExecution,
  createMockTask,
  createMockTaskRun,
  createMockWorkflow,
} from "../test/test-utils";
import { useChatStore } from "./chatStore";
import { useExecutionStore } from "./executionStore";
import { resetProjectScopedStores } from "./projectScopedStores";
import { useSessionLogStore } from "./sessionLogStore";
import { useStepStore } from "./stepStore";
import { useTaskRunStore } from "./taskRunStore";
import { useTaskStore } from "./taskStore";
import { useWorkflowStore } from "./workflowStore";

describe("resetProjectScopedStores", () => {
  beforeEach(() => {
    resetProjectScopedStores();
  });

  it("clears task, workflow, execution, run, log, and local chat state from the previous project", () => {
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
    useTaskStore.setState({
      tasks: [task],
      selectedTaskId: task.id,
      selectedTask: task,
      isLoading: true,
    });
    useWorkflowStore.setState({
      workflows: [workflow],
      currentWorkflow: { workflow, tasks: [task] },
      isLoading: true,
    });
    useStepStore.setState({
      steps: [step],
      selectedStepId: step.id,
      selectedStep: step,
    });
    useExecutionStore.setState({
      executions: [execution],
      executionsByTaskId: { [task.id]: [execution] },
    });
    useTaskRunStore.setState({
      taskRuns: [taskRun],
      taskRunsByTaskId: { [task.id]: [taskRun] },
    });
    useSessionLogStore.setState({
      logsByExecutionId: { [execution.id ?? "execution-1"]: [sessionLog] },
    });
    useChatStore.setState({
      sessions: {
        "chat-1": {
          id: "chat-1",
          scope: "task",
          entityId: task.id,
          label: "Old task",
          messages: [],
          status: "open",
          claudeSessionId: "claude-1",
          claudeConversationId: null,
          contextSummary: null,
        },
      },
      activeSessionId: "chat-1",
      panelOpen: true,
    });
    resetProjectScopedStores();

    expect(useTaskStore.getState()).toMatchObject({
      tasks: [],
      selectedTaskId: null,
      selectedTask: null,
      isLoading: false,
    });
    expect(useWorkflowStore.getState()).toMatchObject({
      workflows: [],
      currentWorkflow: null,
      isLoading: false,
    });
    expect(useStepStore.getState()).toMatchObject({
      steps: [],
      selectedStepId: null,
      selectedStep: null,
    });
    expect(useExecutionStore.getState()).toMatchObject({
      executions: [],
      executionsByTaskId: {},
    });
    expect(useTaskRunStore.getState()).toMatchObject({
      taskRuns: [],
      taskRunsByTaskId: {},
    });
    expect(useSessionLogStore.getState().logsByExecutionId).toEqual({});
    expect(useChatStore.getState()).toMatchObject({
      sessions: {},
      activeSessionId: null,
      panelOpen: false,
    });
  });
});
