import { describe, it, expect } from "vitest";
import {
  defaultLineageScopeForRun,
  filterExecutions,
  filterTaggedEvents,
  matchesSearch,
  scopedRunIdsForLineage,
} from "./applyFilters";
import type { TaggedConversationEvent } from "../../types/conversation";
import {
  createMockStepExecution,
  createMockTaskRun,
} from "../../test/test-utils";

const baseFilters = {
  status: null,
  stepName: null,
  model: null,
  search: "",
  rootOnly: false,
  lineageScope: null,
};

describe("filterExecutions", () => {
  const root = createMockStepExecution({
    id: "root-1",
    task_id: "root",
    status: "completed",
    step_name: "in_progress",
    model: "opus",
  });
  const child = createMockStepExecution({
    id: "child-1",
    task_id: "child",
    status: "failed",
    step_name: "review",
    model: "haiku",
  });
  const list = [root, child];

  it("status filter selects only matching status", () => {
    const out = filterExecutions(
      list,
      { ...baseFilters, status: "failed" },
      { rootTaskId: "root" }
    );
    expect(out.map((e) => e.id)).toEqual(["child-1"]);
  });

  it("stepName filter selects only matching step", () => {
    const out = filterExecutions(
      list,
      { ...baseFilters, stepName: "review" },
      { rootTaskId: "root" }
    );
    expect(out.map((e) => e.id)).toEqual(["child-1"]);
  });

  it("model filter selects only matching model", () => {
    const out = filterExecutions(
      list,
      { ...baseFilters, model: "opus" },
      { rootTaskId: "root" }
    );
    expect(out.map((e) => e.id)).toEqual(["root-1"]);
  });

  it("rootOnly drops executions whose task isn't the root", () => {
    const out = filterExecutions(
      list,
      { ...baseFilters, rootOnly: true },
      { rootTaskId: "root" }
    );
    expect(out.map((e) => e.id)).toEqual(["root-1"]);
  });

  it("filters compose: status + stepName narrow further", () => {
    const out = filterExecutions(
      list,
      { ...baseFilters, status: "failed", stepName: "in_progress" },
      { rootTaskId: "root" }
    );
    expect(out).toHaveLength(0);
  });

  it("scopedRunIds narrows by TaskRun id instead of task id", () => {
    const retryA = createMockStepExecution({
      id: "retry-a",
      task_id: "child",
      task_run_id: "run-a",
    });
    const retryB = createMockStepExecution({
      id: "retry-b",
      task_id: "child",
      task_run_id: "run-b",
    });
    const out = filterExecutions([retryA, retryB], baseFilters, {
      rootTaskId: "child",
      scopedRunIds: new Set(["run-b"]),
    });
    expect(out.map((e) => e.id)).toEqual(["retry-b"]);
  });

  it("deduplicates step executions that appear through overlapping run scopes", () => {
    const parentExec = createMockStepExecution({
      id: "shared-parent-exec",
      task_id: "root",
      task_run_id: "run-parent",
    });
    const childExec = createMockStepExecution({
      id: "shared-child-exec",
      task_id: "child",
      task_run_id: "run-child",
    });
    const out = filterExecutions(
      [parentExec, childExec, parentExec, childExec],
      baseFilters,
      {
        rootTaskId: "root",
        scopedRunIds: new Set(["run-parent", "run-child"]),
      }
    );
    expect(out.map((e) => e.id)).toEqual([
      "shared-parent-exec",
      "shared-child-exec",
    ]);
  });
});

describe("TaskRun lineage scopes", () => {
  it("defaults child runs to descendants scope and root runs to full lineage", () => {
    expect(
      defaultLineageScopeForRun(
        createMockTaskRun({
          id: "run-root",
          parent_task_run_id: null,
          root_task_run_id: "run-root",
        })
      )
    ).toBe("lineage");
    expect(
      defaultLineageScopeForRun(
        createMockTaskRun({
          id: "run-child",
          parent_task_run_id: "run-root",
          root_task_run_id: "run-root",
        })
      )
    ).toBe("descendants");
    expect(
      defaultLineageScopeForRun(
        createMockTaskRun({
          id: "run-child-with-parent-only",
          parent_task_run_id: "run-root",
          root_task_run_id: "run-child-with-parent-only",
        })
      )
    ).toBe("descendants");
    expect(
      defaultLineageScopeForRun(
        createMockTaskRun({
          id: "run-child-with-root-only",
          parent_task_run_id: null,
          root_task_run_id: "run-root",
        })
      )
    ).toBe("descendants");
  });

  it("returns selected run and descendants without including siblings", () => {
    const ids = scopedRunIdsForLineage(
      [
        createMockTaskRun({ id: "run-root" }),
        createMockTaskRun({
          id: "run-child",
          parent_task_run_id: "run-root",
        }),
        createMockTaskRun({
          id: "run-grandchild",
          parent_task_run_id: "run-child",
        }),
        createMockTaskRun({
          id: "run-sibling",
          parent_task_run_id: "run-root",
        }),
      ],
      "run-child",
      "descendants"
    );
    expect(ids).toEqual(new Set(["run-child", "run-grandchild"]));
  });

  it("returns null for full lineage so callers keep the whole tree", () => {
    expect(scopedRunIdsForLineage([], "run-child", "lineage")).toBeNull();
  });

  it("does not loop when descendant TaskRun parent links contain a cycle", () => {
    const ids = scopedRunIdsForLineage(
      [
        createMockTaskRun({
          id: "run-a",
          parent_task_run_id: "run-b",
        }),
        createMockTaskRun({
          id: "run-b",
          parent_task_run_id: "run-a",
        }),
      ],
      "run-a",
      "descendants"
    );
    expect(ids).toEqual(new Set(["run-a", "run-b"]));
  });
});

function tag(
  executionId: string,
  event: TaggedConversationEvent["event"]
): TaggedConversationEvent {
  return {
    event,
    executionId,
    taskId: "task-1",
    workflowId: null,
    stepName: null,
    executionStartedAt: null,
    eventIndex: 0,
  };
}

describe("matchesSearch / filterTaggedEvents", () => {
  it("matchesSearch is case-insensitive across thinking text", () => {
    const t = tag("e1", {
      kind: "thinking",
      timestamp: "2024-01-01T00:00:00Z",
      text: "Hello WORLD",
    });
    expect(matchesSearch(t, "world")).toBe(true);
    expect(matchesSearch(t, "missing")).toBe(false);
  });

  it("matchesSearch finds within tool_call name and summary", () => {
    const t = tag("e1", {
      kind: "tool_call",
      timestamp: "2024-01-01T00:00:00Z",
      toolId: "x",
      toolName: "Bash",
      displayName: "Bash",
      icon: "terminal",
      summary: "list files",
      input: { command: "ls" },
    });
    expect(matchesSearch(t, "bash")).toBe(true);
    expect(matchesSearch(t, "list")).toBe(true);
    expect(matchesSearch(t, "ls")).toBe(true);
    expect(matchesSearch(t, "nope")).toBe(false);
  });

  it("matchesSearch returns true on empty search regardless of event", () => {
    const t = tag("e1", {
      kind: "thinking",
      timestamp: "1",
      text: "anything",
    });
    expect(matchesSearch(t, "")).toBe(true);
    // session_end has no searchable surface; an empty search must still pass
    // it (kills the !search early-return short-circuit).
    const sessionEnd = tag("e1", {
      kind: "session_end",
      timestamp: "1",
      durationMs: 1,
      numTurns: 1,
      costUsd: 0,
    });
    expect(matchesSearch(sessionEnd, "")).toBe(true);
  });

  it("matchesSearch matches independently across the three tool_call subfields", () => {
    const onlyName = tag("e1", {
      kind: "tool_call",
      timestamp: "1",
      toolId: "x",
      toolName: "UniqueToolXYZ",
      displayName: "UniqueToolXYZ",
      icon: "terminal",
      summary: "boring",
      input: { a: 1 },
    });
    expect(matchesSearch(onlyName, "uniquetoolxyz")).toBe(true);

    const onlySummary = tag("e1", {
      kind: "tool_call",
      timestamp: "1",
      toolId: "x",
      toolName: "Bash",
      displayName: "Bash",
      icon: "terminal",
      summary: "very-distinct-summary",
      input: { a: 1 },
    });
    expect(matchesSearch(onlySummary, "very-distinct-summary")).toBe(true);

    const onlyInput = tag("e1", {
      kind: "tool_call",
      timestamp: "1",
      toolId: "x",
      toolName: "Bash",
      displayName: "Bash",
      icon: "terminal",
      summary: "boring",
      input: { command: "needle-in-input" },
    });
    expect(matchesSearch(onlyInput, "needle-in-input")).toBe(true);
  });

  it("filterTaggedEvents narrows by free-text search across allowed executions", () => {
    const match = tag("good", {
      kind: "thinking",
      timestamp: "1",
      text: "find me here",
    });
    const noMatch = tag("good", {
      kind: "thinking",
      timestamp: "1",
      text: "completely different",
    });
    const out = filterTaggedEvents(
      [match, noMatch],
      { ...baseFilters, search: "find me" },
      new Set(["good"])
    );
    expect(out).toEqual([match]);
  });

  it("filterTaggedEvents drops events whose execution is excluded", () => {
    const t1 = tag("good", {
      kind: "thinking",
      timestamp: "1",
      text: "x",
    });
    const t2 = tag("bad", {
      kind: "thinking",
      timestamp: "1",
      text: "x",
    });
    const out = filterTaggedEvents(
      [t1, t2],
      { ...baseFilters, search: "" },
      new Set(["good"])
    );
    expect(out.map((e) => e.executionId)).toEqual(["good"]);
  });
});
