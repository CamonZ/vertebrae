import { describe, expect, it } from "vitest";
import type { TaskFilterOptions } from "../bindings";
import {
  createMockTask,
  createMockTaskRun,
  createMockTaskRunControls,
} from "../test/test-utils";
import {
  mergeTask,
  taskMatchesFilter,
  taskRunControlsEqual,
} from "./taskMerge";

function taskFilter(overrides: Partial<TaskFilterOptions>): TaskFilterOptions {
  return {
    step_names: null,
    levels: null,
    tags: null,
    root_only: null,
    children_of: null,
    search: null,
    workflow_id: null,
    step_id: null,
    ...overrides,
  };
}

describe("taskMerge helpers", () => {
  describe("mergeTask", () => {
    it("preserves hydrated fields when an update omits them", () => {
      const sections = [
        {
          type: "checklist_item" as const,
          content: "Keep checklist",
          order: 1,
          done: false,
          done_at: null,
        },
      ];
      const codeRefs = [
        {
          path: "src/main.rs",
          line_start: 4,
          line_end: 9,
          name: "main",
          description: "entrypoint",
        },
      ];
      const existing = createMockTask({
        id: "task-1",
        title: "Before",
        sections,
        code_refs: codeRefs,
        dependency_ids: ["dep-1"],
        tags: ["frontend"],
      });
      const update = createMockTask({
        id: existing.id,
        title: "After",
        description: "Updated description",
      });
      delete update.sections;
      delete update.code_refs;
      delete update.dependency_ids;
      delete update.tags;

      expect(mergeTask(existing, update)).toEqual({
        ...existing,
        ...update,
        sections,
        code_refs: codeRefs,
        dependency_ids: ["dep-1"],
        tags: ["frontend"],
      });
    });

    it("uses explicit empty arrays from update payloads", () => {
      const existing = createMockTask({
        id: "task-1",
        sections: [
          {
            type: "constraint" as const,
            content: "Old",
            order: 1,
            done: null,
            done_at: null,
          },
        ],
        code_refs: [
          {
            path: "src/lib.rs",
            line_start: 1,
            line_end: null,
            name: null,
            description: null,
          },
        ],
        dependency_ids: ["dep-1"],
        tags: ["old-tag"],
      });
      const update = createMockTask({
        id: existing.id,
        sections: [],
        code_refs: [],
        dependency_ids: [],
        tags: [],
      });

      expect(mergeTask(existing, update)).toMatchObject({
        id: existing.id,
        sections: [],
        code_refs: [],
        dependency_ids: [],
        tags: [],
      });
    });
  });

  describe("taskMatchesFilter", () => {
    const task = createMockTask({
      id: "task-visible",
      title: "Implement Cache Patch",
      description: "Preserve hydrated payloads",
      level: "ticket",
      tags: ["frontend", "urgent"],
      parent_id: "epic-1",
      workflow_id: "workflow-1",
      current_step_id: "step-1",
      step_name: "in_progress",
    });

    it("matches the same backend filters used by task list queries", () => {
      expect(
        taskMatchesFilter(
          task,
          taskFilter({
            levels: ["ticket"],
            tags: ["urgent"],
            children_of: "epic-1",
            search: "cache",
            workflow_id: "workflow-1",
            step_id: "step-1",
            step_names: ["in_progress"],
          })
        )
      ).toBe(true);
    });

    it("rejects archived tasks and filter mismatches", () => {
      expect(taskMatchesFilter({ ...task, archived: true }, null)).toBe(false);
      expect(taskMatchesFilter(task, taskFilter({ levels: ["epic"] }))).toBe(
        false
      );
      expect(taskMatchesFilter(task, taskFilter({ tags: ["backend"] }))).toBe(
        false
      );
      expect(taskMatchesFilter(task, taskFilter({ root_only: true }))).toBe(
        false
      );
      expect(
        taskMatchesFilter(task, taskFilter({ children_of: "other-parent" }))
      ).toBe(false);
      expect(taskMatchesFilter(task, taskFilter({ search: "missing" }))).toBe(
        false
      );
      expect(
        taskMatchesFilter(task, taskFilter({ workflow_id: "workflow-2" }))
      ).toBe(false);
      expect(taskMatchesFilter(task, taskFilter({ step_id: "step-2" }))).toBe(
        false
      );
      expect(
        taskMatchesFilter(task, taskFilter({ step_names: ["review"] }))
      ).toBe(false);
    });
  });

  describe("taskRunControlsEqual", () => {
    it("compares nullish and structurally equal controls consistently", () => {
      const activeRun = createMockTaskRun({
        id: "run-1",
        task_id: "task-1",
      });
      const controls = createMockTaskRunControls(activeRun);

      expect(taskRunControlsEqual(null, undefined)).toBe(true);
      expect(
        taskRunControlsEqual(controls, {
          ...controls,
          active_run: { ...activeRun },
        })
      ).toBe(true);
      expect(
        taskRunControlsEqual(controls, {
          ...controls,
          stoppable: false,
        })
      ).toBe(false);
    });
  });
});
