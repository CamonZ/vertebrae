import { describe, expect, it } from "vitest";
import type { TaskFilterOptions } from "../bindings";
import { queryKeys } from "./queryKeys";

describe("queryKeys", () => {
  it("builds project-scoped task keys", () => {
    const filter: TaskFilterOptions = {
      levels: ["ticket"],
      search: "query",
      step_names: null,
      tags: null,
      root_only: null,
      children_of: null,
      workflow_id: null,
      step_id: null,
    };

    expect(queryKeys.project(3)).toEqual(["project", 3]);
    expect(queryKeys.tasks.all(3)).toEqual(["project", 3, "tasks"]);
    expect(queryKeys.tasks.lists(3)).toEqual(["project", 3, "tasks", "list"]);
    expect(queryKeys.tasks.list(3, filter)).toEqual([
      "project",
      3,
      "tasks",
      "list",
      filter,
    ]);
    expect(queryKeys.tasks.ready(3)).toEqual(["project", 3, "tasks", "ready"]);
    expect(queryKeys.tasks.details(3)).toEqual([
      "project",
      3,
      "tasks",
      "detail",
    ]);
    expect(queryKeys.tasks.detail(3, "task-1")).toEqual([
      "project",
      3,
      "tasks",
      "detail",
      "task-1",
    ]);
  });

  it("builds project-scoped workflow keys", () => {
    expect(queryKeys.workflows.all(7)).toEqual(["project", 7, "workflows"]);
    expect(queryKeys.workflows.list(7)).toEqual([
      "project",
      7,
      "workflows",
      "list",
    ]);
    expect(queryKeys.workflows.details(7)).toEqual([
      "project",
      7,
      "workflows",
      "detail",
    ]);
    expect(queryKeys.workflows.detail(7, "workflow-1")).toEqual([
      "project",
      7,
      "workflows",
      "detail",
      "workflow-1",
    ]);
  });

  it("builds project- and task-scoped artifact keys", () => {
    expect(queryKeys.artifacts.all(6)).toEqual(["project", 6, "artifacts"]);
    expect(queryKeys.artifacts.project(6)).toEqual([
      "project",
      6,
      "artifacts",
      "project",
    ]);
    expect(queryKeys.artifacts.task(6, "task-1")).toEqual([
      "project",
      6,
      "artifacts",
      "task",
      "task-1",
    ]);
  });

  it("builds project-scoped execution keys", () => {
    expect(queryKeys.executions.all(5)).toEqual(["project", 5, "executions"]);
    expect(queryKeys.executions.byTask(5, "task-1")).toEqual([
      "project",
      5,
      "executions",
      "byTask",
      "task-1",
    ]);
    expect(queryKeys.executions.byRun(5, "run-1")).toEqual([
      "project",
      5,
      "executions",
      "byRun",
      "run-1",
    ]);
  });

  it("builds project-scoped step and workflow transition keys", () => {
    expect(queryKeys.steps.byId(4, "step-1")).toEqual([
      "project",
      4,
      "steps",
      "byId",
      "step-1",
    ]);
    expect(queryKeys.workflowTransitions.list(4)).toEqual([
      "project",
      4,
      "workflowTransitions",
      "list",
    ]);
    expect(queryKeys.pipelineSummary(4)).toEqual([
      "project",
      4,
      "pipelineSummary",
    ]);
  });
});
