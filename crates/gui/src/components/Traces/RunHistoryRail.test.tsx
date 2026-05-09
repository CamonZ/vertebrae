import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render, createMockTaskRun } from "../../test/test-utils";
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

    const buttons = screen.getAllByTestId("run-history-row-button");
    fireEvent.click(buttons[1]);
    expect(onSelectRun).toHaveBeenCalledWith("run-2");
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
});
