import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PipelineSummary,
  TaskChangedEvent,
  TaskStepChangedEvent,
} from "../bindings";
import { queryClient, queryKeys } from "../query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { createMockTask } from "../test/test-utils";

const { taskHandlers, taskStepHandlers, emptyListen, getPipelineSummary } =
  vi.hoisted(() => ({
  taskHandlers: [] as Array<(event: { payload: TaskChangedEvent }) => void>,
  taskStepHandlers: [] as Array<
    (event: { payload: TaskStepChangedEvent }) => void
  >,
  emptyListen: vi.fn(async () => vi.fn()),
  getPipelineSummary: vi.fn(),
}));

vi.mock("../bindings", () => ({
  commands: { getPipelineSummary },
  events: {
    taskChangedEvent: {
      listen: vi.fn(
        (handler: (event: { payload: TaskChangedEvent }) => void) => {
          taskHandlers.push(handler);
          return Promise.resolve(vi.fn());
        }
      ),
    },
    taskStepChangedEvent: {
      listen: vi.fn(
        (handler: (event: { payload: TaskStepChangedEvent }) => void) => {
          taskStepHandlers.push(handler);
          return Promise.resolve(vi.fn());
        }
      ),
    },
    taskRunStepChangedEvent: { listen: emptyListen },
    stepChangedEvent: { listen: emptyListen },
    stepTransitionChangedEvent: { listen: emptyListen },
    workflowChangedEvent: { listen: emptyListen },
    workflowTransitionChangedEvent: { listen: emptyListen },
  },
}));

vi.mock("./useWebSocketStatus", () => ({
  useWebSocketStatus: () => "connected",
}));

import { usePipelineSummary } from "./usePipelineSummary";

const summary = (
  ticketCount = 0,
  secondStepTicketCount = 0,
): PipelineSummary => ({
  workflows: [
    {
      id: "workflow-1",
      name: "Workflow",
      description: null,
      initial_step_id: "step-1",
      kanban_column: null,
      factory_name: null,
      is_default: true,
      display_order: 0,
      workflow_steps: [
        {
          id: "step-1",
          name: "Todo",
          workflow_id: "workflow-1",
          goal: null,
          step_order: 0,
          step_type: "execute",
          transitions_to: [],
          task_counts: { epic: 0, ticket: ticketCount, task: 0 },
          pipeline_counts: {
            epic: 0,
            ticket: ticketCount,
            task: 0,
            active: 0,
          },
          active_count: 0,
        },
        {
          id: "step-2",
          name: "Doing",
          workflow_id: "workflow-1",
          goal: null,
          step_order: 1,
          step_type: "execute",
          transitions_to: [],
          task_counts: {
            epic: 0,
            ticket: secondStepTicketCount,
            task: 0,
          },
          pipeline_counts: {
            epic: 0,
            ticket: secondStepTicketCount,
            task: 0,
            active: 0,
          },
          active_count: 0,
        },
      ],
      transitions: [],
    },
  ],
});

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

describe("usePipelineSummary", () => {
  beforeEach(() => {
    resetProjectScopedStores();
    queryClient.clear();
    taskHandlers.length = 0;
    taskStepHandlers.length = 0;
    vi.clearAllMocks();
    getPipelineSummary.mockResolvedValue({ status: "ok", data: summary() });
  });

  it("keys data by project generation and ignores stale event listeners", async () => {
    const { result } = renderHook(() => usePipelineSummary(), { wrapper });
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    const staleHandler = taskHandlers[0];
    const oldGeneration = getProjectScopeGeneration();

    act(() => resetProjectScopedStores());
    await waitFor(() => expect(taskHandlers).toHaveLength(2));
    const newGeneration = getProjectScopeGeneration();
    await waitFor(() =>
      expect(
        queryClient.getQueryData(queryKeys.pipelineSummary(newGeneration))
      ).toBeDefined()
    );
    queryClient.setQueryData(queryKeys.pipelineSummary(oldGeneration), summary());

    act(() => {
      staleHandler({
        payload: {
          task_id: "old-task",
          change_type: "Created",
          task: createMockTask({
            id: "old-task",
            current_step_id: "step-1",
            level: "ticket",
          }),
          current_step_id: "step-1",
          workflow_id: "workflow-1",
          level: "ticket",
          archived: false,
        },
      });
    });

    const current = queryClient.getQueryData<PipelineSummary>(
      queryKeys.pipelineSummary(newGeneration)
    );
    expect(current?.workflows[0].workflow_steps[0].task_counts.ticket).toBe(0);
    expect(
      queryClient.getQueryData<PipelineSummary>(
        queryKeys.pipelineSummary(oldGeneration)
      )?.workflows[0].workflow_steps[0].task_counts.ticket
    ).toBe(0);
  });

  it("reduces archive updates without refetching", async () => {
    getPipelineSummary.mockResolvedValue({ status: "ok", data: summary(1) });
    const { result } = renderHook(() => usePipelineSummary(), { wrapper });
    await waitFor(() => expect(taskHandlers).toHaveLength(1));
    await waitFor(() => expect(getPipelineSummary).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        result.current.summary?.workflows[0].workflow_steps[0].task_counts
          .ticket
      ).toBe(1)
    );

    act(() => {
      taskHandlers[0]({
        payload: {
          task_id: "task-1",
          change_type: "Updated",
          task: createMockTask({
            id: "task-1",
            current_step_id: "step-1",
            workflow_id: "workflow-1",
            level: "ticket",
            archived: true,
          }),
          current_step_id: "step-1",
          workflow_id: "workflow-1",
          level: "ticket",
          archived: true,
          previous: { archived: false },
        },
      });
    });

    await waitFor(() =>
      expect(
        result.current.summary?.workflows[0].workflow_steps[0].task_counts
          .ticket
      ).toBe(0)
    );
    expect(getPipelineSummary).toHaveBeenCalledTimes(1);
  });

  it("retries when a task update overlaps the initial fetch", async () => {
    let resolveInitial: ((value: unknown) => void) | undefined;
    getPipelineSummary
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          })
      )
      .mockResolvedValueOnce({ status: "ok", data: summary(0) });

    const { result } = renderHook(() => usePipelineSummary(), { wrapper });
    await waitFor(() => expect(taskHandlers).toHaveLength(1));

    act(() => {
      taskHandlers[0]({
        payload: {
          task_id: "task-1",
          change_type: "Updated",
          task: createMockTask({ id: "task-1", archived: true }),
          current_step_id: "step-1",
          workflow_id: "workflow-1",
          level: "ticket",
          archived: true,
          previous: { archived: false },
        },
      });
      resolveInitial?.({ status: "ok", data: summary(1) });
    });

    await waitFor(() => expect(getPipelineSummary).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        result.current.summary?.workflows[0].workflow_steps[0].task_counts
          .ticket
      ).toBe(0)
    );
  });

  it("leaves step movement to the semantic event", async () => {
    getPipelineSummary.mockResolvedValue({ status: "ok", data: summary(1, 0) });
    const { result } = renderHook(() => usePipelineSummary(), { wrapper });
    await waitFor(() => expect(result.current.summary).not.toBeNull());

    act(() => {
      taskHandlers[0]({
        payload: {
          task_id: "task-1",
          change_type: "Updated",
          task: createMockTask({
            id: "task-1",
            current_step_id: "step-2",
            workflow_id: "workflow-1",
            level: "ticket",
            archived: false,
          }),
          current_step_id: "step-2",
          workflow_id: "workflow-1",
          level: "ticket",
          archived: false,
          previous: { current_step_id: "step-1" },
        },
      });
      taskStepHandlers[0]({
        payload: {
          task_id: "task-1",
          from_step_id: "step-1",
          to_step_id: "step-2",
          workflow_id: "workflow-1",
          level: "ticket",
        },
      });
    });

    await waitFor(() =>
      expect(
        result.current.summary?.workflows[0].workflow_steps.map(
          (step) => step.task_counts.ticket
        )
      ).toEqual([0, 1])
    );
    expect(getPipelineSummary).toHaveBeenCalledTimes(1);
  });

  it("reconciles a combined archive and step update authoritatively", async () => {
    getPipelineSummary
      .mockResolvedValueOnce({ status: "ok", data: summary(1, 0) })
      .mockResolvedValue({ status: "ok", data: summary(0, 0) });
    const { result } = renderHook(() => usePipelineSummary(), { wrapper });
    await waitFor(() => expect(result.current.summary).not.toBeNull());

    act(() => {
      taskHandlers[0]({
        payload: {
          task_id: "task-1",
          change_type: "Updated",
          task: createMockTask({
            id: "task-1",
            current_step_id: "step-2",
            workflow_id: "workflow-1",
            level: "ticket",
            archived: true,
          }),
          current_step_id: "step-2",
          workflow_id: "workflow-1",
          level: "ticket",
          archived: true,
          previous: {
            archived: false,
            current_step_id: "step-1",
          },
        },
      });
      taskStepHandlers[0]({
        payload: {
          task_id: "task-1",
          from_step_id: "step-1",
          to_step_id: "step-2",
          workflow_id: "workflow-1",
          level: "ticket",
        },
      });
    });

    await waitFor(() =>
      expect(
        result.current.summary?.workflows[0].workflow_steps.map(
          (step) => step.task_counts.ticket
        )
      ).toEqual([0, 0])
    );
    expect(getPipelineSummary.mock.calls.length).toBeGreaterThan(1);
  });

  it("reconciles a combined level and step update authoritatively", async () => {
    const reconciled = summary(0, 0);
    reconciled.workflows[0].workflow_steps[1].task_counts.task = 1;
    reconciled.workflows[0].workflow_steps[1].pipeline_counts.task = 1;
    getPipelineSummary
      .mockResolvedValueOnce({ status: "ok", data: summary(1, 0) })
      .mockResolvedValue({ status: "ok", data: reconciled });
    const { result } = renderHook(() => usePipelineSummary(), { wrapper });
    await waitFor(() => expect(result.current.summary).not.toBeNull());

    act(() => {
      taskHandlers[0]({
        payload: {
          task_id: "task-1",
          change_type: "Updated",
          task: createMockTask({
            id: "task-1",
            current_step_id: "step-2",
            workflow_id: "workflow-1",
            level: "task",
            archived: false,
          }),
          current_step_id: "step-2",
          workflow_id: "workflow-1",
          level: "task",
          archived: false,
          previous: {
            level: "ticket",
            current_step_id: "step-1",
          },
        },
      });
      taskStepHandlers[0]({
        payload: {
          task_id: "task-1",
          from_step_id: "step-1",
          to_step_id: "step-2",
          workflow_id: "workflow-1",
          level: "task",
        },
      });
    });

    await waitFor(() =>
      expect(
        result.current.summary?.workflows[0].workflow_steps.map((step) => ({
          ticket: step.task_counts.ticket,
          task: step.task_counts.task,
        }))
      ).toEqual([
        { ticket: 0, task: 0 },
        { ticket: 0, task: 1 },
      ])
    );
    expect(getPipelineSummary.mock.calls.length).toBeGreaterThan(1);
  });
});
