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
    expect(queryKeys.tasks.ready(3)).toEqual([
      "project",
      3,
      "tasks",
      "ready",
    ]);
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
});
