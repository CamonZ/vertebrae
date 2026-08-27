import { beforeEach, describe, expect, it } from "vitest";
import type {
  Section,
  Step,
  TaskRunTrace,
  TaskFilterOptions,
  WorkflowWithTasks,
  WorkflowTransition,
} from "../bindings";
import {
  createMockStepExecution,
  createMockStep,
  createMockTask,
  createMockTaskRun,
  createMockTaskRunControls,
  createMockWorkflow,
} from "../test/test-utils";
import { queryClient } from "./queryClient";
import { queryKeys } from "./queryKeys";
import {
  removeTaskFromQueryCache,
  removeStepFromQueryCache,
  removeWorkflowTransitionFromQueryCache,
  removeWorkflowFromQueryCache,
  mergeFetchedTaskRuns,
  replaceTaskRunControlsInQueryCache,
  updateTaskSectionsInQueryCache,
  updateTaskLocationInQueryCache,
  upsertStepExecutionInQueryCache,
  upsertStepInQueryCache,
  upsertTaskInQueryCache,
  upsertWorkflowInQueryCache,
  upsertWorkflowTransitionInQueryCache,
  upsertArtifactInQueryCache,
  removeArtifactFromQueryCache,
} from "./serverCache";

describe("server cache helpers", () => {
  beforeEach(() => {
    queryClient.clear();
  });

  it("updates initialized project and task artifact projections without refetching", () => {
    const generation = 4;
    const artifact = {
      id: "artifact-1",
      project_id: "project-1",
      filename: "notes.md",
      body: "# Notes",
      logical_name: "notes",
      metadata: null,
      created_at: null,
      updated_at: null,
    };
    queryClient.setQueryData(queryKeys.artifacts.project(generation), [
      artifact,
    ]);
    queryClient.setQueryData(queryKeys.artifacts.task(generation, "task-1"), [
      artifact,
    ]);
    upsertArtifactInQueryCache(
      { ...artifact, body: "# Updated" },
      null,
      generation
    );
    expect(
      queryClient.getQueryData<(typeof artifact)[]>(
        queryKeys.artifacts.project(generation)
      )?.[0].body
    ).toBe("# Updated");
    removeArtifactFromQueryCache("artifact-1", null, generation);
    expect(
      queryClient.getQueryData(queryKeys.artifacts.project(generation))
    ).toEqual([]);
    expect(
      queryClient.getQueryData(queryKeys.artifacts.task(generation, "task-1"))
    ).toEqual([]);
  });

  it("keeps a websocket TaskRun update received while a fetch was in flight", () => {
    const stale = createMockTaskRun({ id: "run-1", status: "queued" });
    const websocketUpdate = createMockTaskRun({
      id: "run-1",
      status: "executing",
    });

    expect(mergeFetchedTaskRuns([stale], [websocketUpdate], [stale])).toEqual([
      websocketUpdate,
    ]);
  });

  it("retains a websocket-created TaskRun absent from an older fetch", () => {
    const current = createMockTaskRun({ id: "run-new", status: "executing" });
    expect(mergeFetchedTaskRuns([], [current], [])).toEqual([current]);
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

  it("upserts step executions into existing by-task and by-run entries", () => {
    const generation = 22;
    const original = createMockStepExecution({
      id: "exec-1",
      task_id: "task-1",
      task_run_id: "run-1",
      status: "in_progress",
    });
    const updated = createMockStepExecution({
      ...original,
      status: "completed",
      completed_at: "2026-01-01T00:10:00.000Z",
    });
    const otherGenerationExecution = createMockStepExecution({
      id: "exec-other",
      task_id: "task-1",
      task_run_id: "run-1",
    });
    const trace: TaskRunTrace = {
      root_task_run_id: "run-1",
      task_runs: [],
      step_executions: [original],
      session_logs: [],
    };

    queryClient.setQueryData(
      queryKeys.executions.byTask(generation, "task-1"),
      [original]
    );
    queryClient.setQueryData(
      queryKeys.executions.byRun(generation, "run-1"),
      trace
    );
    queryClient.setQueryData(
      queryKeys.executions.byTask(generation + 1, "task-1"),
      [otherGenerationExecution]
    );

    upsertStepExecutionInQueryCache(updated, {
      taskId: "task-1",
      taskRunId: "run-1",
      generation,
    });

    expect(
      queryClient.getQueryData(
        queryKeys.executions.byTask(generation, "task-1")
      )
    ).toEqual([updated]);
    expect(
      queryClient.getQueryData<TaskRunTrace>(
        queryKeys.executions.byRun(generation, "run-1")
      )
    ).toEqual({ ...trace, step_executions: [updated] });
    expect(
      queryClient.getQueryData(
        queryKeys.executions.byTask(generation + 1, "task-1")
      )
    ).toEqual([otherGenerationExecution]);
  });

  it("does not create absent execution query entries from live upserts", () => {
    const generation = 23;
    const execution = createMockStepExecution({
      id: "exec-1",
      task_id: "task-1",
      task_run_id: "run-1",
    });

    upsertStepExecutionInQueryCache(execution, {
      taskId: "task-1",
      taskRunId: "run-1",
      generation,
    });

    expect(
      queryClient.getQueryData(
        queryKeys.executions.byTask(generation, "task-1")
      )
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(queryKeys.executions.byRun(generation, "run-1"))
    ).toBeUndefined();
  });

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
    queryClient.setQueryData(queryKeys.tasks.ready(generation), [
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
    expect(queryClient.getQueryData(queryKeys.tasks.ready(generation))).toEqual(
      [taskOutsideFilter]
    );
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
    queryClient.setQueryData(queryKeys.tasks.ready(generation), [existingTask]);

    upsertTaskInQueryCache(update, generation);

    expect(
      queryClient.getQueryData(queryKeys.tasks.list(generation, ticketFilter))
    ).toEqual([{ ...existingTask, ...update, tags: [] }]);
    expect(queryClient.getQueryData(queryKeys.tasks.ready(generation))).toEqual(
      [{ ...existingTask, ...update, tags: [] }]
    );
  });

  it("merges detail cache entries without wiping omitted hydrated fields", () => {
    const generation = 12;
    const existingTask = createMockTask({
      id: "task-1",
      title: "Before",
      sections: [
        {
          type: "goal",
          content: "Keep me",
          order: 1,
          done: null,
          done_at: null,
        },
      ],
      code_refs: [
        {
          path: "src/main.rs",
          line_start: 1,
          line_end: null,
          name: null,
          description: null,
        },
      ],
    });
    const update = createMockTask({
      id: existingTask.id,
      title: "After",
      workflow_name: "Implementation",
      step_name: "todo",
    });
    delete update.sections;
    delete update.code_refs;

    queryClient.setQueryData(
      queryKeys.tasks.detail(generation, existingTask.id),
      existingTask
    );

    upsertTaskInQueryCache(update, generation);

    expect(
      queryClient.getQueryData(
        queryKeys.tasks.detail(generation, existingTask.id)
      )
    ).toEqual({
      ...existingTask,
      ...update,
      sections: existingTask.sections,
      code_refs: existingTask.code_refs,
    });
  });

  it("inserts runnable tasks into an existing ready feed", () => {
    const generation = 12;
    const task = createMockTask({
      id: "task-ready",
      run_controls: {
        runnable: true,
        stoppable: false,
        disabled_reason_code: null,
        disabled_reason: null,
        active_run: null,
      },
    });
    const otherTask = createMockTask({ id: "task-other" });
    queryClient.setQueryData(queryKeys.tasks.ready(generation), [otherTask]);

    upsertTaskInQueryCache(task, generation);

    expect(queryClient.getQueryData(queryKeys.tasks.ready(generation))).toEqual(
      [otherTask, task]
    );
  });

  it("leaves loading list queries undefined during cache patches", () => {
    const generation = 12;
    const key = queryKeys.tasks.list(generation, ticketFilter);
    const task = createMockTask({ id: "task-1", level: "ticket" });
    queryClient.setQueryData(key, undefined);

    upsertTaskInQueryCache(task, generation);

    expect(queryClient.getQueryData(key)).toBeUndefined();
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
    queryClient.setQueryData(queryKeys.tasks.ready(generation), [
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
    expect(queryClient.getQueryData(queryKeys.tasks.ready(generation))).toEqual(
      [otherTask]
    );
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
    queryClient.setQueryData(queryKeys.tasks.ready(generation), [
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
    expect(queryClient.getQueryData(queryKeys.tasks.ready(generation))).toEqual(
      [{ ...task, run_controls: runControls }, otherTask]
    );
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
    queryClient.setQueryData(queryKeys.tasks.ready(generation), [
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
    expect(queryClient.getQueryData(queryKeys.tasks.ready(generation))).toEqual(
      [{ ...task, sections: [updatedSection] }, otherTask]
    );

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
    expect(queryClient.getQueryData(queryKeys.tasks.ready(generation))).toEqual(
      [{ ...task, sections: [] }, otherTask]
    );
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

  it("scopes Step and WorkflowTransition cache writes by generation", () => {
    const generation = 31;
    const step = {
      ...createMockStep({ id: "step-1", workflow_id: "workflow-1" }),
      name: "Canonical step",
    } as Step;
    const transition: WorkflowTransition = {
      id: "transition-1",
      from_workflow_id: "workflow-1",
      from_workflow_name: "Workflow 1",
      to_workflow_id: "workflow-2",
      to_workflow_name: "Workflow 2",
      label: "continue",
      target_step_id: null,
    };

    upsertStepInQueryCache(step, generation);
    upsertWorkflowTransitionInQueryCache(transition, generation);

    expect(
      queryClient.getQueryData(queryKeys.steps.byId(generation, step.id!))
    ).toEqual(step);
    expect(
      queryClient.getQueryData(queryKeys.steps.byId(generation + 1, step.id!))
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(queryKeys.workflowTransitions.list(generation))
    ).toEqual([transition]);
    expect(
      queryClient.getQueryData(
        queryKeys.workflowTransitions.list(generation + 1)
      )
    ).toBeUndefined();

    removeStepFromQueryCache(step.id!, generation);
    removeWorkflowTransitionFromQueryCache(transition.id!, generation);
    expect(
      queryClient.getQueryData(queryKeys.steps.byId(generation, step.id!))
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(queryKeys.workflowTransitions.list(generation))
    ).toEqual([]);
  });

  it("preserves persistence options in realtime step projections", () => {
    const generation = 32;
    const step = createMockStep({
      id: "step-persist",
      persistence_options: { artifact: { logical_name: "result" } },
    });
    queryClient.setQueryData(queryKeys.steps.byId(generation, step.id!), {
      ...step,
      persistence_options: null,
    });

    upsertStepInQueryCache(step, generation);

    expect(
      queryClient.getQueryData<Step>(queryKeys.steps.byId(generation, step.id!))
        ?.persistence_options
    ).toEqual({ artifact: { logical_name: "result" } });
  });

  it("reconciles filtered task lists after a canonical location update", () => {
    const generation = 6;
    const filter: TaskFilterOptions = {
      step_names: ["review"],
      levels: null,
      tags: null,
      root_only: null,
      children_of: null,
      search: null,
      workflow_id: null,
      step_id: null,
    };
    const task = createMockTask({
      id: "task-1",
      workflow_id: "workflow-1",
      current_step_id: "step-todo",
      step_name: "todo",
    });
    queryClient.setQueryData(queryKeys.tasks.list(generation, filter), [task]);
    queryClient.setQueryData(queryKeys.workflows.list(generation), [
      createMockWorkflow({ id: "workflow-1", name: "Implementation" }),
    ]);
    queryClient.setQueryData(
      queryKeys.steps.byId(generation, "step-review"),
      createMockStep({
        id: "step-review",
        workflow_id: "workflow-1",
        name: "review",
      })
    );

    updateTaskLocationInQueryCache(
      task.id,
      "step-review",
      "workflow-1",
      generation
    );

    expect(
      queryClient.getQueryData(queryKeys.tasks.list(generation, filter))
    ).toEqual([
      expect.objectContaining({
        id: task.id,
        current_step_id: "step-review",
      }),
    ]);

    queryClient.setQueryData(
      queryKeys.steps.byId(generation, "step-done"),
      createMockStep({
        id: "step-done",
        workflow_id: "workflow-1",
        name: "done",
      })
    );
    updateTaskLocationInQueryCache(
      task.id,
      "step-done",
      "workflow-1",
      generation
    );
    expect(
      queryClient.getQueryData(queryKeys.tasks.list(generation, filter))
    ).toEqual([]);
  });
});
