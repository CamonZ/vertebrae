import { describe, it, expect } from "vitest";
import { filterExecutions, matchesSearch } from "./applyFilters";
import { createMockStepExecution } from "../../test/test-utils";
import type { TraceFilters } from "../../hooks/useTraceFilters";
import type { TaggedConversationEvent } from "../../types/conversation";

const noFilters: TraceFilters = {
  status: null,
  stepName: null,
  model: null,
  search: "",
  rootOnly: false,
  lineageScope: null,
  view: "all",
};

describe("filterExecutions (single-run)", () => {
  const execs = [
    createMockStepExecution({
      id: "ex-1",
      task_id: "root",
      status: "completed",
      step_name: "in_progress",
      model: "claude",
    }),
    createMockStepExecution({
      id: "ex-2",
      task_id: "child",
      status: "failed",
      step_name: "review",
      model: "codex",
    }),
  ];

  it("returns all executions with no filters", () => {
    expect(filterExecutions(execs, noFilters, { rootTaskId: "root" })).toHaveLength(
      2
    );
  });

  it("filters by status", () => {
    const out = filterExecutions(
      execs,
      { ...noFilters, status: "failed" },
      { rootTaskId: "root" }
    );
    expect(out.map((e) => e.id)).toEqual(["ex-2"]);
  });

  it("filters by step name and model", () => {
    expect(
      filterExecutions(
        execs,
        { ...noFilters, stepName: "review" },
        { rootTaskId: "root" }
      ).map((e) => e.id)
    ).toEqual(["ex-2"]);
    expect(
      filterExecutions(
        execs,
        { ...noFilters, model: "claude" },
        { rootTaskId: "root" }
      ).map((e) => e.id)
    ).toEqual(["ex-1"]);
  });

  it("rootOnly keeps only the root task's executions", () => {
    expect(
      filterExecutions(
        execs,
        { ...noFilters, rootOnly: true },
        { rootTaskId: "root" }
      ).map((e) => e.id)
    ).toEqual(["ex-1"]);
  });

  it("dedupes executions by id", () => {
    expect(
      filterExecutions([execs[0], execs[0]], noFilters, {
        rootTaskId: "root",
      })
    ).toHaveLength(1);
  });
});

describe("matchesSearch", () => {
  const tag = (
    event: TaggedConversationEvent["event"]
  ): TaggedConversationEvent => ({
    executionId: "ex-1",
    taskId: "root",
    workflowId: null,
    stepName: null,
    executionStartedAt: null,
    eventIndex: 0,
    event,
  });

  it("matches thinking text case-insensitively", () => {
    expect(
      matchesSearch(
        tag({ kind: "thinking", text: "Decompose", timestamp: "" } as never),
        "decom"
      )
    ).toBe(true);
  });

  it("returns true for an empty search", () => {
    expect(
      matchesSearch(
        tag({ kind: "thinking", text: "x", timestamp: "" } as never),
        ""
      )
    ).toBe(true);
  });
});
