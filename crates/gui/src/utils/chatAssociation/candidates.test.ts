import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../../query/queryClient";
import { queryKeys } from "../../query/queryKeys";
import { getProjectScopeGeneration } from "../../stores/projectScopedStores";
import { createMockTask, createMockStep } from "../../test/test-utils";
import { cachedAssociationCandidates } from "./candidates";

describe("association candidates from existing server cache", () => {
  beforeEach(() => queryClient.clear());
  it("reads and deduplicates list/detail rows without invoking a query function", () => {
    const generation = getProjectScopeGeneration();
    const fetch = vi.fn();
    const task = createMockTask({
      id: "97a3edab-5e4a-40a8-b580-19708657a222",
      title: "Cached ticket",
      level: "ticket",
    });
    queryClient.setQueryDefaults(queryKeys.tasks.lists(generation), {
      queryFn: fetch,
    });
    queryClient.setQueryData(queryKeys.tasks.list(generation, null), [task]);
    queryClient.setQueryData(queryKeys.tasks.detail(generation, task.id), {
      ...task,
      title: "Updated title",
    });

    expect(cachedAssociationCandidates(generation)).toEqual([
      { id: task.id, title: "Updated title", level: "ticket" },
    ]);

    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not fetch when the cache is empty or the scope changed", () => {
    const generation = getProjectScopeGeneration();

    expect(cachedAssociationCandidates(generation)).toEqual([]);
    queryClient.setQueryData(queryKeys.tasks.list(generation + 1, null), [
      createMockTask(),
    ]);

    expect(cachedAssociationCandidates(generation + 1)).toEqual([]);
  });
  it("excludes archived, completed, finished-step rows", () => {
    const generation = getProjectScopeGeneration();
    const tasks = [
      createMockTask({ id: "active", level: "ticket" }),
      createMockTask({ id: "archived", level: "ticket", archived: true }),
      createMockTask({
        id: "completed",
        level: "ticket",
        completed_at: "2026-10-25T12:00:00Z",
      }),
      createMockTask({ id: "epic", level: "epic" }),
      createMockTask({ id: "finish", level: "ticket", step_type: "finish" }),
      createMockTask({
        id: "cached-step",
        level: "ticket",
        current_step_id: "finished-step",
        step_type: "execute",
      }),
    ];
    queryClient.setQueryData(queryKeys.tasks.list(generation, null), tasks);
    queryClient.setQueryData(
      queryKeys.steps.byId(generation, "finished-step"),
      createMockStep({ id: "finished-step", step_type: "finish" })
    );

    expect(
      cachedAssociationCandidates(generation).map((ticket) => ticket.id)
    ).toEqual(["active", "epic"]);
  });
  it.each(["epic", "ticket", "task"] as const)(
    "uses the same eligibility rules for %s",
    (level) => {
      const generation = getProjectScopeGeneration();
      queryClient.setQueryData(queryKeys.tasks.list(generation, null), [
        createMockTask({ id: "eligible", level }),
        createMockTask({ id: "archived", level, archived: true }),
        createMockTask({
          id: "completed",
          level,
          completed_at: "2026-11-08T00:00:00Z",
        }),
        createMockTask({ id: "finish", level, step_type: "finish" }),
      ]);

      expect(cachedAssociationCandidates(generation)).toEqual([
        { id: "eligible", title: expect.any(String), level },
      ]);
    }
  );
});
