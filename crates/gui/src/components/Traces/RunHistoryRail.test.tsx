import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  render,
  createMockTask,
  createMockTaskRun,
} from "../../test/test-utils";
import { RunHistoryRail } from "./RunHistoryRail";
import type { TaskRun } from "../../bindings";

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return createMockTaskRun({
    task_id: "task-1",
    started_at: "2026-01-01T00:00:00.000Z",
    inserted_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("RunHistoryRail", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders one row per run with status pip and short id", () => {
    const runs = [
      run({
        id: "run-active",
        status: "executing",
        started_at: "2026-01-02T08:30:00.000Z",
      }),
      run({
        id: "run-done",
        status: "completed",
        started_at: "2026-01-01T08:00:00.000Z",
      }),
    ];
    render(
      <RunHistoryRail
        runs={runs}
        activeRunId="run-active"
        activeRunSource="active"
        onSelectRun={() => undefined}
      />
    );

    const rows = screen.getAllByTestId("run-history-row");
    expect(rows.map((r) => r.getAttribute("data-run-id"))).toEqual([
      "run-active",
      "run-done",
    ]);
    expect(rows[0].getAttribute("data-status")).toBe("executing");
    expect(rows[0].getAttribute("data-terminal")).toBe("false");
    expect(rows[1].getAttribute("data-terminal")).toBe("true");
    expect(rows[0].getAttribute("data-active")).toBe("true");
    expect(rows[0].getAttribute("data-active-source")).toBe("active");
    // Short id render appears in the row content.
    expect(screen.getByText(/run-acti/i)).toBeTruthy();
  });

  it("invokes onSelectRun with the row's id when clicked", () => {
    const onSelectRun = vi.fn();
    render(
      <RunHistoryRail
        runs={[
          run({ id: "run-1", status: "completed" }),
          run({ id: "run-2", status: "completed" }),
        ]}
        activeRunId="run-1"
        activeRunSource="latest"
        onSelectRun={onSelectRun}
      />
    );

    const run2Row = screen
      .getAllByTestId("run-history-row")
      .find((row) => row.getAttribute("data-run-id") === "run-2");
    if (!run2Row) throw new Error("missing run-2 row");
    fireEvent.click(run2Row.querySelector("button")!);
    expect(onSelectRun).toHaveBeenCalledWith("run-2");
  });

  it("groups by task id even before task metadata loads", () => {
    render(
      <RunHistoryRail
        runs={[
          run({
            id: "run-stopped",
            task_id: "task-1",
            status: "stopped",
            started_at: "2026-01-01T08:00:00.000Z",
          }),
          run({
            id: "run-active",
            task_id: "task-1",
            status: "executing",
            started_at: "2026-01-01T09:00:00.000Z",
          }),
          run({
            id: "run-child",
            task_id: "task-child",
            status: "completed",
            started_at: "2026-01-01T10:00:00.000Z",
          }),
        ]}
        activeRunId="run-active"
        activeRunSource="selected"
        onSelectRun={() => undefined}
      />
    );

    const groups = screen.getAllByTestId("run-history-task-group");
    expect(groups.map((g) => g.getAttribute("data-task-id"))).toEqual([
      "task-1",
      "task-child",
    ]);
    expect(
      screen
        .getAllByTestId("run-history-task-group-id")
        .map((badge) => badge.getAttribute("data-full-id"))
    ).toEqual(["task-1", "task-child"]);
    expect(groups.map((g) => g.getAttribute("data-attempt-count"))).toEqual([
      "2",
      "1",
    ]);
    const rows = screen.getAllByTestId("run-history-row");
    expect(rows.map((r) => r.getAttribute("data-run-id"))).toEqual([
      "run-active",
      "run-stopped",
      "run-child",
    ]);
  });

  it("groups stopped and restarted attempts under one task node before child task groups", () => {
    render(
      <RunHistoryRail
        tasks={[
          createMockTask({
            id: "task-1",
            title: "Ticket task",
            level: "ticket",
          }),
          createMockTask({
            id: "task-child",
            title: "Child task",
            level: "task",
            parent_id: "task-1",
          }),
        ]}
        runs={[
          run({
            id: "run-stopped",
            task_id: "task-1",
            status: "stopped",
            started_at: "2026-01-01T08:00:00.000Z",
          }),
          run({
            id: "run-active",
            task_id: "task-1",
            status: "executing",
            started_at: "2026-01-01T09:00:00.000Z",
          }),
          run({
            id: "run-child",
            task_id: "task-child",
            status: "completed",
            started_at: "2026-01-01T10:00:00.000Z",
          }),
        ]}
        activeRunId="run-active"
        activeRunSource="active"
        onSelectRun={() => undefined}
      />
    );

    const groups = screen.getAllByTestId("run-history-task-group");
    expect(groups.map((g) => g.getAttribute("data-task-id"))).toEqual([
      "task-1",
      "task-child",
    ]);
    expect(groups.map((g) => g.getAttribute("data-attempt-count"))).toEqual([
      "2",
      "1",
    ]);
    expect(
      screen
        .getAllByTestId("run-history-task-group-id")
        .map((badge) => badge.getAttribute("data-full-id"))
    ).toEqual(["task-1", "task-child"]);
    expect(
      screen
        .getAllByTestId("run-history-row")
        .map((r) => r.getAttribute("data-run-id"))
    ).toEqual(["run-active", "run-stopped", "run-child"]);
  });

  it("collapses and expands a task group with its runs and descendants", () => {
    render(
      <RunHistoryRail
        tasks={[
          createMockTask({
            id: "task-1",
            title: "Ticket task",
            level: "ticket",
          }),
          createMockTask({
            id: "task-child",
            title: "Child task",
            level: "task",
            parent_id: "task-1",
          }),
        ]}
        runs={[
          run({
            id: "run-stopped",
            task_id: "task-1",
            status: "stopped",
            started_at: "2026-01-01T08:00:00.000Z",
          }),
          run({
            id: "run-active",
            task_id: "task-1",
            status: "executing",
            started_at: "2026-01-01T09:00:00.000Z",
          }),
          run({
            id: "run-child",
            task_id: "task-child",
            status: "completed",
            started_at: "2026-01-01T10:00:00.000Z",
          }),
        ]}
        activeRunId="run-active"
        activeRunSource="selected"
        onSelectRun={() => undefined}
      />
    );

    const rootToggle = screen.getAllByTestId(
      "run-history-task-group-toggle"
    )[0];
    expect(rootToggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(rootToggle);
    expect(rootToggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen
        .getAllByTestId("run-history-task-group")
        .map((group) => group.getAttribute("data-task-id"))
    ).toEqual(["task-1"]);
    expect(screen.queryAllByTestId("run-history-row")).toHaveLength(0);

    fireEvent.click(rootToggle);
    expect(rootToggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen
        .getAllByTestId("run-history-task-group")
        .map((group) => group.getAttribute("data-task-id"))
    ).toEqual(["task-1", "task-child"]);
    expect(
      screen
        .getAllByTestId("run-history-row")
        .map((row) => row.getAttribute("data-run-id"))
    ).toEqual(["run-active", "run-stopped", "run-child"]);
  });

  it("deduplicates repeated runs and does not loop on cyclic parent data", () => {
    render(
      <RunHistoryRail
        runs={[
          run({ id: "run-root", parent_task_run_id: null }),
          run({ id: "run-child", parent_task_run_id: "run-root" }),
          run({ id: "run-child", parent_task_run_id: "run-root" }),
          run({ id: "run-cycle-a", parent_task_run_id: "run-cycle-b" }),
          run({ id: "run-cycle-b", parent_task_run_id: "run-cycle-a" }),
        ]}
        activeRunId="run-root"
        activeRunSource="selected"
        onSelectRun={() => undefined}
      />
    );

    const rows = screen.getAllByTestId("run-history-row");
    expect(new Set(rows.map((r) => r.getAttribute("data-run-id")))).toEqual(
      new Set(["run-root", "run-child", "run-cycle-a", "run-cycle-b"])
    );
  });

  it("renders a source label for non-selected sources", () => {
    render(
      <RunHistoryRail
        runs={[run({ id: "run-1", status: "executing" })]}
        activeRunId="run-1"
        activeRunSource="active"
        onSelectRun={() => undefined}
      />
    );
    const source = screen.getByTestId("run-history-row-source");
    expect(source.textContent).toBe("active");
  });

  it("hides the source label when the run is explicitly selected", () => {
    render(
      <RunHistoryRail
        runs={[run({ id: "run-1", status: "completed" })]}
        activeRunId="run-1"
        activeRunSource="selected"
        onSelectRun={() => undefined}
      />
    );
    expect(screen.queryByTestId("run-history-row-source")).toBeNull();
  });

  it("renders an empty state when there are no runs", () => {
    render(
      <RunHistoryRail
        runs={[]}
        activeRunId={null}
        activeRunSource="none"
        onSelectRun={() => undefined}
      />
    );
    expect(screen.getByTestId("run-history-rail-empty")).toBeTruthy();
    expect(screen.queryByTestId("run-history-row")).toBeNull();
  });

  it("collapses to a thin rail when collapsed=true", () => {
    const onToggleCollapsed = vi.fn();
    render(
      <RunHistoryRail
        runs={[run({ id: "run-1", status: "executing" })]}
        activeRunId="run-1"
        activeRunSource="active"
        onSelectRun={() => undefined}
        collapsed
        onToggleCollapsed={onToggleCollapsed}
      />
    );
    const rail = screen.getByTestId("run-history-rail");
    expect(rail.getAttribute("data-collapsed")).toBe("true");
    fireEvent.click(screen.getByTestId("run-history-rail-toggle"));
    expect(onToggleCollapsed).toHaveBeenCalled();
  });

  it("emits onSwitchTask when the switch action is clicked", () => {
    const onSwitchTask = vi.fn();
    render(
      <RunHistoryRail
        runs={[run({ id: "run-1", status: "completed" })]}
        activeRunId="run-1"
        activeRunSource="latest"
        onSelectRun={() => undefined}
        onSwitchTask={onSwitchTask}
      />
    );
    fireEvent.click(screen.getByTestId("run-history-rail-switch-task"));
    expect(onSwitchTask).toHaveBeenCalled();
  });

  it("supports keyboard resizing and persists the panel width", () => {
    render(
      <RunHistoryRail
        runs={[run({ id: "run-1", status: "completed" })]}
        activeRunId="run-1"
        activeRunSource="latest"
        onSelectRun={() => undefined}
      />
    );
    const rail = screen.getByTestId("run-history-rail");
    const handle = screen.getByTestId("run-history-rail-resize-handle");

    expect(rail).toHaveStyle({ width: "288px" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(rail).toHaveStyle({ width: "304px" });
    expect(
      window.localStorage.getItem("vertebrae.traces.runHistoryRail.width")
    ).toBe("304");
  });
});
