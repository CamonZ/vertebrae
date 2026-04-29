import { describe, it, expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { render, createMockTask, createMockStepExecution } from "../../test/test-utils";
import { SubtreeRail } from "./SubtreeRail";

const root = createMockTask({
  id: "root",
  title: "Root Epic",
  level: "epic",
  parent_id: null,
});
const child = createMockTask({
  id: "child",
  title: "Child Ticket",
  level: "ticket",
  parent_id: "root",
});
const grand = createMockTask({
  id: "grand",
  title: "Grand Task",
  level: "task",
  parent_id: "child",
});

const tasks = [root, child, grand];
const subtreeTaskIds = ["root", "child", "grand"];

const executions = [
  createMockStepExecution({
    id: "e-root-1",
    task_id: "root",
    step_name: "review",
    status: "completed",
    cost: 0.5,
    duration_ms: 1000,
  }),
  createMockStepExecution({
    id: "e-child-1",
    task_id: "child",
    step_name: "in_progress",
    status: "failed",
    cost: 0.25,
    duration_ms: 1000,
  }),
  createMockStepExecution({
    id: "e-child-2",
    task_id: "child",
    step_name: "in_progress",
    status: "completed",
    cost: 0.1,
    duration_ms: 500,
  }),
  createMockStepExecution({
    id: "e-grand-1",
    task_id: "grand",
    step_name: "in_progress",
    status: "in_progress",
    cost: 0.0,
  }),
];

describe("SubtreeRail", () => {
  it("renders groups in depth order", () => {
    render(
      <SubtreeRail
        rootTaskId="root"
        tasks={tasks}
        subtreeTaskIds={subtreeTaskIds}
        executions={executions}
      />
    );
    const groups = screen.getAllByTestId("subtree-rail-group");
    expect(groups.map((g) => g.getAttribute("data-task-id"))).toEqual([
      "root",
      "child",
      "grand",
    ]);
    expect(groups[0].getAttribute("data-depth")).toBe("0");
    expect(groups[1].getAttribute("data-depth")).toBe("1");
    expect(groups[2].getAttribute("data-depth")).toBe("2");
  });

  it("shows per-group rollups with run counts and cost", () => {
    render(
      <SubtreeRail
        rootTaskId="root"
        tasks={tasks}
        subtreeTaskIds={subtreeTaskIds}
        executions={executions}
      />
    );
    const childGroup = screen
      .getAllByTestId("subtree-rail-group")
      .find((g) => g.getAttribute("data-task-id") === "child");
    expect(childGroup).toBeDefined();
    if (!childGroup) return;
    const runs = within(childGroup).getByTestId("subtree-rail-group-runs");
    const cost = within(childGroup).getByTestId("subtree-rail-group-cost");
    expect(runs.textContent).toBe("2 runs");
    expect(cost.textContent).toMatch(/\$0\.35/);
  });

  it("renders status pips reflecting the per-group execution statuses", () => {
    render(
      <SubtreeRail
        rootTaskId="root"
        tasks={tasks}
        subtreeTaskIds={subtreeTaskIds}
        executions={executions}
      />
    );
    const childGroup = screen
      .getAllByTestId("subtree-rail-group")
      .find((g) => g.getAttribute("data-task-id") === "child");
    if (!childGroup) throw new Error("missing child group");
    const pips = within(childGroup).getByTestId("subtree-rail-group-pips");
    const failed = pips.querySelector('[data-status="failed"]');
    const completed = pips.querySelector('[data-status="completed"]');
    expect(failed).not.toBeNull();
    expect(completed).not.toBeNull();
    expect(failed?.getAttribute("data-count")).toBe("1");
    expect(completed?.getAttribute("data-count")).toBe("1");
  });

  it("collapses and expands a group on toggle click", () => {
    render(
      <SubtreeRail
        rootTaskId="root"
        tasks={tasks}
        subtreeTaskIds={subtreeTaskIds}
        executions={executions}
      />
    );
    const rootGroup = screen
      .getAllByTestId("subtree-rail-group")
      .find((g) => g.getAttribute("data-task-id") === "root");
    if (!rootGroup) throw new Error("missing root group");
    expect(rootGroup.getAttribute("data-expanded")).toBe("true");
    expect(
      within(rootGroup).queryByTestId("subtree-rail-group-executions")
    ).not.toBeNull();

    fireEvent.click(within(rootGroup).getByTestId("subtree-rail-group-toggle"));
    expect(rootGroup.getAttribute("data-expanded")).toBe("false");
    expect(
      within(rootGroup).queryByTestId("subtree-rail-group-executions")
    ).toBeNull();

    fireEvent.click(within(rootGroup).getByTestId("subtree-rail-group-toggle"));
    expect(rootGroup.getAttribute("data-expanded")).toBe("true");
  });

  it("renders an empty state when no tasks are in the subtree", () => {
    render(
      <SubtreeRail
        rootTaskId="missing"
        tasks={[]}
        subtreeTaskIds={[]}
        executions={[]}
      />
    );
    expect(screen.getByTestId("subtree-rail-empty")).toBeInTheDocument();
  });

  it("renders collapsed mode with a toggle button", () => {
    render(
      <SubtreeRail
        rootTaskId="root"
        tasks={tasks}
        subtreeTaskIds={subtreeTaskIds}
        executions={executions}
        collapsed
        onToggleCollapsed={() => {}}
      />
    );
    const rail = screen.getByTestId("subtree-rail");
    expect(rail.getAttribute("data-collapsed")).toBe("true");
    expect(screen.getByTestId("subtree-rail-toggle")).toBeInTheDocument();
  });
});
