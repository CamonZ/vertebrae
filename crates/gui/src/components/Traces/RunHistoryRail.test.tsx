import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  render,
  createMockTask,
  createMockTaskRun,
} from "../../test/test-utils";
import { RunHistoryRail } from "./RunHistoryRail";
import type { Task, TaskRun } from "../../bindings";

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return createMockTaskRun({
    task_id: "task-1",
    started_at: "2026-01-01T00:00:00.000Z",
    inserted_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

const NOOP = (): void => undefined;

describe("RunHistoryRail", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe("TASKS panel", () => {
    it("renders the task tree with depth and highlights the current task", () => {
      const tasks: Task[] = [
        createMockTask({ id: "ticket-1", title: "Refactor auth", level: "ticket" }),
        createMockTask({
          id: "task-jwt",
          title: "Implement JWT",
          level: "task",
          parent_id: "ticket-1",
        }),
        createMockTask({
          id: "task-openapi",
          title: "Update OpenAPI",
          level: "task",
          parent_id: "ticket-1",
        }),
      ];
      render(
        <RunHistoryRail
          tasks={tasks}
          runs={[]}
          currentTaskId="task-jwt"
          activeRunId={null}
          activeRunSource="none"
          onSelectTask={NOOP}
          onSelectRun={NOOP}
        />
      );

      const rows = screen.getAllByTestId("run-history-task-row");
      expect(rows.map((r) => r.getAttribute("data-task-id"))).toEqual([
        "ticket-1",
        "task-jwt",
        "task-openapi",
      ]);
      expect(rows.map((r) => r.getAttribute("data-depth"))).toEqual([
        "0",
        "1",
        "1",
      ]);
      expect(rows.map((r) => r.getAttribute("data-active"))).toEqual([
        "false",
        "true",
        "false",
      ]);
    });

    it("calls onSelectTask with the row's id when a task is clicked", () => {
      const onSelectTask = vi.fn();
      const tasks: Task[] = [
        createMockTask({ id: "ticket-1", title: "Refactor auth", level: "ticket" }),
        createMockTask({
          id: "task-jwt",
          title: "Implement JWT",
          level: "task",
          parent_id: "ticket-1",
        }),
      ];
      render(
        <RunHistoryRail
          tasks={tasks}
          runs={[]}
          currentTaskId="ticket-1"
          activeRunId={null}
          activeRunSource="none"
          onSelectTask={onSelectTask}
          onSelectRun={NOOP}
        />
      );

      const jwtRow = screen
        .getAllByTestId("run-history-task-row")
        .find((row) => row.getAttribute("data-task-id") === "task-jwt");
      if (!jwtRow) throw new Error("missing jwt row");
      fireEvent.click(jwtRow.querySelector("button")!);
      expect(onSelectTask).toHaveBeenCalledWith("task-jwt");
    });

    it("renders an empty state when there are no tasks", () => {
      render(
        <RunHistoryRail
          tasks={[]}
          runs={[]}
          currentTaskId={null}
          activeRunId={null}
          activeRunSource="none"
          onSelectTask={NOOP}
          onSelectRun={NOOP}
        />
      );
      expect(screen.getByTestId("run-history-tasks-empty")).toBeTruthy();
    });
  });

  describe("RUNS panel", () => {
    it("only shows runs for the currently selected task", () => {
      const runs = [
        run({
          id: "run-current-a",
          task_id: "task-1",
          status: "executing",
          started_at: "2026-01-02T08:30:00.000Z",
        }),
        run({
          id: "run-current-b",
          task_id: "task-1",
          status: "completed",
          started_at: "2026-01-01T08:00:00.000Z",
        }),
        run({
          id: "run-other",
          task_id: "task-2",
          status: "completed",
          started_at: "2026-01-03T00:00:00.000Z",
        }),
      ];
      render(
        <RunHistoryRail
          tasks={[
            createMockTask({ id: "task-1", title: "First" }),
            createMockTask({ id: "task-2", title: "Second" }),
          ]}
          runs={runs}
          currentTaskId="task-1"
          activeRunId="run-current-a"
          activeRunSource="active"
          onSelectTask={NOOP}
          onSelectRun={NOOP}
        />
      );

      const rows = screen.getAllByTestId("run-history-row");
      expect(rows.map((r) => r.getAttribute("data-run-id"))).toEqual([
        "run-current-a",
        "run-current-b",
      ]);
      expect(rows[0].getAttribute("data-status")).toBe("executing");
      expect(rows[0].getAttribute("data-terminal")).toBe("false");
      expect(rows[1].getAttribute("data-terminal")).toBe("true");
      expect(rows[0].getAttribute("data-active")).toBe("true");
      expect(rows[0].getAttribute("data-active-source")).toBe("active");
    });

    it("invokes onSelectRun with the row's id when clicked", () => {
      const onSelectRun = vi.fn();
      render(
        <RunHistoryRail
          tasks={[createMockTask({ id: "task-1", title: "Task" })]}
          runs={[
            run({ id: "run-1", task_id: "task-1", status: "completed" }),
            run({ id: "run-2", task_id: "task-1", status: "completed" }),
          ]}
          currentTaskId="task-1"
          activeRunId="run-1"
          activeRunSource="latest"
          onSelectTask={NOOP}
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

    it("sorts runs newest-first within the selected task", () => {
      render(
        <RunHistoryRail
          tasks={[createMockTask({ id: "task-1", title: "Task" })]}
          runs={[
            run({
              id: "run-old",
              task_id: "task-1",
              status: "completed",
              started_at: "2026-01-01T00:00:00.000Z",
            }),
            run({
              id: "run-mid",
              task_id: "task-1",
              status: "stopped",
              started_at: "2026-01-02T00:00:00.000Z",
            }),
            run({
              id: "run-new",
              task_id: "task-1",
              status: "executing",
              started_at: "2026-01-03T00:00:00.000Z",
            }),
          ]}
          currentTaskId="task-1"
          activeRunId="run-new"
          activeRunSource="active"
          onSelectTask={NOOP}
          onSelectRun={NOOP}
        />
      );

      const rows = screen.getAllByTestId("run-history-row");
      expect(rows.map((r) => r.getAttribute("data-run-id"))).toEqual([
        "run-new",
        "run-mid",
        "run-old",
      ]);
    });

    it("renders a source label for non-selected sources", () => {
      render(
        <RunHistoryRail
          tasks={[createMockTask({ id: "task-1", title: "Task" })]}
          runs={[run({ id: "run-1", task_id: "task-1", status: "executing" })]}
          currentTaskId="task-1"
          activeRunId="run-1"
          activeRunSource="active"
          onSelectTask={NOOP}
          onSelectRun={NOOP}
        />
      );
      const source = screen.getByTestId("run-history-row-source");
      expect(source.textContent).toBe("active");
    });

    it("hides the source label when the run is explicitly selected", () => {
      render(
        <RunHistoryRail
          tasks={[createMockTask({ id: "task-1", title: "Task" })]}
          runs={[run({ id: "run-1", task_id: "task-1", status: "completed" })]}
          currentTaskId="task-1"
          activeRunId="run-1"
          activeRunSource="selected"
          onSelectTask={NOOP}
          onSelectRun={NOOP}
        />
      );
      expect(screen.queryByTestId("run-history-row-source")).toBeNull();
    });

    it("shows a 'no runs' empty state when the selected task has no runs", () => {
      render(
        <RunHistoryRail
          tasks={[createMockTask({ id: "task-1", title: "Task" })]}
          runs={[]}
          currentTaskId="task-1"
          activeRunId={null}
          activeRunSource="none"
          onSelectTask={NOOP}
          onSelectRun={NOOP}
        />
      );
      expect(screen.getByTestId("run-history-rail-empty")).toBeTruthy();
      expect(screen.queryByTestId("run-history-row")).toBeNull();
    });

    it("shows a 'select a task' prompt when no task is selected", () => {
      render(
        <RunHistoryRail
          tasks={[createMockTask({ id: "task-1", title: "Task" })]}
          runs={[run({ id: "run-1", task_id: "task-1", status: "completed" })]}
          currentTaskId={null}
          activeRunId={null}
          activeRunSource="none"
          onSelectTask={NOOP}
          onSelectRun={NOOP}
        />
      );
      expect(screen.getByTestId("run-history-rail-empty").textContent).toMatch(
        /select a task/i
      );
      expect(screen.queryByTestId("run-history-row")).toBeNull();
    });
  });

  describe("chrome", () => {
    it("collapses to a thin rail when collapsed=true", () => {
      const onToggleCollapsed = vi.fn();
      render(
        <RunHistoryRail
          tasks={[createMockTask({ id: "task-1", title: "Task" })]}
          runs={[run({ id: "run-1", task_id: "task-1", status: "executing" })]}
          currentTaskId="task-1"
          activeRunId="run-1"
          activeRunSource="active"
          onSelectTask={NOOP}
          onSelectRun={NOOP}
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
          tasks={[createMockTask({ id: "task-1", title: "Task" })]}
          runs={[run({ id: "run-1", task_id: "task-1", status: "completed" })]}
          currentTaskId="task-1"
          activeRunId="run-1"
          activeRunSource="latest"
          onSelectTask={NOOP}
          onSelectRun={NOOP}
          onSwitchTask={onSwitchTask}
        />
      );
      fireEvent.click(screen.getByTestId("run-history-rail-switch-task"));
      expect(onSwitchTask).toHaveBeenCalled();
    });

    it("supports keyboard resizing and persists the panel width", () => {
      render(
        <RunHistoryRail
          tasks={[createMockTask({ id: "task-1", title: "Task" })]}
          runs={[run({ id: "run-1", task_id: "task-1", status: "completed" })]}
          currentTaskId="task-1"
          activeRunId="run-1"
          activeRunSource="latest"
          onSelectTask={NOOP}
          onSelectRun={NOOP}
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
});
