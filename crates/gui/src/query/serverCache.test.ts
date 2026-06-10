import { beforeEach, describe, expect, it } from "vitest";
import type {
  Section,
  TaskFilterOptions,
  WorkflowWithTasks,
} from "../bindings";
import {
  createMockTask,
  createMockTaskRun,
  createMockTaskRunControls,
  createMockWorkflow,
} from "../test/test-utils";
import { queryClient } from "./queryClient";
import { queryKeys } from "./queryKeys";
import {
  removeTaskFromQueryCache,
  removeWorkflowFromQueryCache,
  replaceTaskRunControlsInQueryCache,
  updateTaskSectionsInQueryCache,
  upsertTaskInQueryCache,
  upsertWorkflowInQueryCache,
} from "./serverCache";

describe("server cache helpers", () => {
  beforeEach(() => {
    queryClient.clear();
  });

  const ticketFilter: TaskFilterOptions = {
    levels: ["ticket"],
    step_names: null,
    tags: null,
    root_only: null,
    children_of: null,
    search: null,
    workflow_id: null,
    step_id: null,
  };

  const epicFilter: TaskFilterOptions = {
    ...ticketFilter,
    levels: ["epic"],
  };

  it("upserts tasks into matching lists and detail cache", () => {
    const generation = 12;
    const task = createMockTask({
      id: "task-1",
      title: "Query task",
      level: "ticket",
    });
    const taskOutsideFilter = createMockTask({
      id: "task-2",
      level: "epic",
    });

    queryClient.setQueryData(queryKeys.tasks.list(generation, null), [
      taskOutsideFilter,
    ]);
    queryClient.setQueryData(
      queryKeys.tasks.list(generation, ticketFilter),
      []
    );
    queryClient.setQueryData(queryKeys.tasks.list(generation, epicFilter), [
      taskOutsideFilter,
    ]);

    upsertTaskInQueryCache(task, generation);

    expect(
      queryClient.getQueryData(queryKeys.tasks.detail(generation, task.id))
    ).toEqual(task);
    expect(
      queryClient.getQueryData(queryKeys.tasks.list(generation, null))
    ).toEqual([taskOutsideFilter, task]);
    expect(
      queryClient.getQueryData(queryKeys.tasks.list(generation, ticketFilter))
    ).toEqual([task]);
    expect(
      queryClient.getQueryData(queryKeys.tasks.list(generation, epicFilter))
    ).toEqual([taskOutsideFilter]);
  });

  it("merges existing tasks without duplicating the first list entry", () => {
    const generation = 12;
    const existingTask = createMockTask({
      id: "task-1",
      title: "Before",
      level: "ticket",
      tags: ["kept"],
    });
    const update = createMockTask({
      id: existingTask.id,
      title: "After",
      level: "ticket",
      tags: [],
    });

    queryClient.setQueryData(queryKeys.tasks.list(generation, ticketFilter), [
      existingTask,
    ]);

    upsertTaskInQueryCache(update, generation);

    expect(
      queryClient.getQueryData(queryKeys.tasks.list(generation, ticketFilter))
    ).toEqual([{ ...existingTask, ...update, tags: existingTask.tags }]);
  });

  it("removes existing tasks from filtered lists when updates no longer match", () => {
    const generation = 12;
    const task = createMockTask({
      id: "task-1",
      title: "Moved task",
      level: "ticket",
    });
    const otherTask = createMockTask({
      id: "task-2",
      title: "Still a ticket",
      level: "ticket",
    });
    const movedTask = { ...task, level: "epic" as const };

    queryClient.setQueryData(queryKeys.tasks.list(generation, ticketFilter), [
      otherTask,
      task,
    ]);

    upsertTaskInQueryCache(movedTask, generation);

    expect(
      queryClient.getQueryData(queryKeys.tasks.list(generation, ticketFilter))
    ).toEqual([otherTask]);
  });

  it("removes tasks from detail and list caches", () => {
    const generation = 4;
    const task = createMockTask({ id: "task-1" });
    const otherTask = createMockTask({ id: "task-2" });

    queryClient.setQueryData(queryKeys.tasks.detail(generation, task.id), task);
    queryClient.setQueryData(queryKeys.tasks.list(generation, null), [
      task,
      otherTask,
    ]);

    removeTaskFromQueryCache(task.id, generation);

    expect(
      queryClient.getQueryData(queryKeys.tasks.detail(generation, task.id))
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(queryKeys.tasks.list(generation, null))
    ).toEqual([otherTask]);
  });

  it("replaces task run controls in detail and list caches", () => {
    const generation = 9;
    const task = createMockTask({ id: "task-1", run_controls: null });
    const otherTask = createMockTask({ id: "task-2", run_controls: null });
    const runControls = createMockTaskRunControls(
      createMockTaskRun({ id: "run-1", task_id: task.id })
    );

    queryClient.setQueryData(queryKeys.tasks.detail(generation, task.id), task);
    queryClient.setQueryData(queryKeys.tasks.list(generation, null), [
      task,
      otherTask,
    ]);

    replaceTaskRunControlsInQueryCache(task.id, runControls, generation);

    expect(
      queryClient.getQueryData(queryKeys.tasks.detail(generation, task.id))
    ).toMatchObject({ id: task.id, run_controls: runControls });
    expect(
      queryClient.getQueryData(queryKeys.tasks.list(generation, null))
    ).toEqual([{ ...task, run_controls: runControls }, otherTask]);
  });

  it("updates task sections in detail and list caches", () => {
    const generation = 10;
    const originalSection: Section = {
      type: "checklist_item",
      content: "Original",
      order: 1,
      done: false,
      done_at: null,
    };
    const updatedSection: Section = {
      ...originalSection,
      content: "Updated",
      done: true,
    };
    const task = createMockTask({
      id: "task-1",
      sections: [originalSection],
    });
    const otherTask = createMockTask({ id: "task-2", sections: [] });

    queryClient.setQueryData(queryKeys.tasks.detail(generation, task.id), task);
    queryClient.setQueryData(queryKeys.tasks.list(generation, null), [
      task,
      otherTask,
    ]);

    updateTaskSectionsInQueryCache(
      task.id,
      updatedSection,
      "upsert",
      generation
    );

    expect(
      queryClient.getQueryData(queryKeys.tasks.detail(generation, task.id))
    ).toMatchObject({ id: task.id, sections: [updatedSection] });
    expect(
      queryClient.getQueryData(queryKeys.tasks.list(generation, null))
    ).toEqual([{ ...task, sections: [updatedSection] }, otherTask]);

    updateTaskSectionsInQueryCache(
      task.id,
      updatedSection,
      "remove",
      generation
    );

    expect(
      queryClient.getQueryData(queryKeys.tasks.detail(generation, task.id))
    ).toMatchObject({ id: task.id, sections: [] });
    expect(
      queryClient.getQueryData(queryKeys.tasks.list(generation, null))
    ).toEqual([{ ...task, sections: [] }, otherTask]);
  });

  it("upserts workflows into list cache and existing matching detail caches", () => {
    const generation = 15;
    const workflowId = "workflow-1";
    const workflow = createMockWorkflow({
      id: workflowId,
      name: "Before",
    });
    const updatedWorkflow = { ...workflow, name: "After" };
    const otherWorkflow = createMockWorkflow({ id: "workflow-2" });
    const workflowDetail: WorkflowWithTasks = {
      workflow,
      tasks: [createMockTask({ workflow_id: workflowId })],
    };
    const otherWorkflowDetail: WorkflowWithTasks = {
      workflow: otherWorkflow,
      tasks: [createMockTask({ workflow_id: otherWorkflow.id ?? undefined })],
    };
    const otherGenerationWorkflowDetail: WorkflowWithTasks = {
      workflow,
      tasks: [createMockTask({ id: "other-generation-task" })],
    };
    const originalList = [workflow, otherWorkflow];

    queryClient.setQueryData(
      queryKeys.workflows.list(generation),
      originalList
    );
    queryClient.setQueryData(
      queryKeys.workflows.detail(generation, workflowId),
      workflowDetail
    );
    queryClient.setQueryData(
      queryKeys.workflows.detail(generation, otherWorkflow.id!),
      otherWorkflowDetail
    );
    queryClient.setQueryData(
      queryKeys.workflows.detail(generation + 1, workflowId),
      otherGenerationWorkflowDetail
    );

    upsertWorkflowInQueryCache(updatedWorkflow, generation);

    expect(originalList).toEqual([workflow, otherWorkflow]);
    expect(
      queryClient.getQueryData(queryKeys.workflows.list(generation))
    ).not.toBe(originalList);
    expect(
      queryClient.getQueryData(queryKeys.workflows.list(generation))
    ).toEqual([updatedWorkflow, otherWorkflow]);
    expect(
      queryClient.getQueryData(
        queryKeys.workflows.detail(generation, workflowId)
      )
    ).toEqual({ ...workflowDetail, workflow: updatedWorkflow });
    expect(
      queryClient.getQueryData(
        queryKeys.workflows.detail(generation, otherWorkflow.id!)
      )
    ).toEqual(otherWorkflowDetail);
    expect(
      queryClient.getQueryData(
        queryKeys.workflows.detail(generation + 1, workflowId)
      )
    ).toEqual(otherGenerationWorkflowDetail);
  });

  it("removes workflows from detail and list caches", () => {
    const generation = 2;
    const workflowId = "workflow-1";
    const workflow = createMockWorkflow({ id: workflowId });
    const otherWorkflow = createMockWorkflow({ id: "workflow-2" });

    queryClient.setQueryData(queryKeys.workflows.list(generation), [
      workflow,
      otherWorkflow,
    ]);
    queryClient.setQueryData(
      queryKeys.workflows.detail(generation, workflowId),
      {
        workflow,
        tasks: [],
      }
    );

    removeWorkflowFromQueryCache(workflowId, generation);

    expect(
      queryClient.getQueryData(
        queryKeys.workflows.detail(generation, workflowId)
      )
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(queryKeys.workflows.list(generation))
    ).toEqual([otherWorkflow]);
  });
});
