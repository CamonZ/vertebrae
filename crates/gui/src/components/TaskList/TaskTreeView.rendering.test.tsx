import { describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  createMockTask,
  createMockTaskRun,
  createMockTaskRunControls,
} from "../../test/test-utils";
import { buildTreeFromTasks } from "../../utils/buildTreeFromTasks";
import { TaskTreeView } from "./TaskTreeView";
import { computeVisibleChildren } from "../../utils/computeVisibleChildren";

vi.mock("../../utils/computeVisibleChildren", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/computeVisibleChildren")>();
  return {
    ...actual,
    computeVisibleChildren: vi.fn(actual.computeVisibleChildren),
  };
});

describe("task tree render isolation", () => {
  it("updates changed branches, embedded run state and selection without rendering unrelated branches", () => {
    const parent = createMockTask({
      id: "parent",
      parent_id: null,
      level: "ticket",
    });
    const child = createMockTask({
      id: "child",
      parent_id: "parent",
      title: "Child",
    });
    const other = createMockTask({
      id: "other",
      parent_id: null,
      title: "Other",
    });
    const cache = new WeakMap();
    const hierarchy = buildTreeFromTasks([parent, child, other], cache);
    const onTaskSelect = vi.fn();
    const props = { hierarchy, isLoading: false, error: null, onTaskSelect };
    const view = render(<TaskTreeView {...props} />);
    vi.mocked(computeVisibleChildren).mockClear();
    const run = createMockTaskRun({
      id: "run",
      task_id: child.id,
      status: "executing",
    });
    const changed = {
      ...child,
      title: "Changed child",
      run_controls: createMockTaskRunControls(run),
    };
    const next = buildTreeFromTasks([parent, changed, other], cache);
    view.rerender(<TaskTreeView {...props} hierarchy={next} />);
    expect(screen.getByText("Changed child")).toBeInTheDocument();
    expect(screen.getByTestId("task-tree-node-run-chip")).toHaveAttribute(
      "data-run-status",
      "executing"
    );
    expect([
      ...new Set(
        vi
          .mocked(computeVisibleChildren)
          .mock.calls.map(([node]) => node.task.id)
      ),
    ]).toEqual(["parent", "child"]);
    vi.mocked(computeVisibleChildren).mockClear();
    view.rerender(
      <TaskTreeView {...props} hierarchy={next} selectedTaskId="child" />
    );
    expect(
      screen.getByText("Changed child").closest('[role="treeitem"]')
    ).toHaveAttribute("aria-selected", "true");
    // Selection does not need to recompute visible children even on the affected branch.
    expect(computeVisibleChildren).not.toHaveBeenCalled();
    view.rerender(
      <TaskTreeView {...props} hierarchy={next} selectedTaskId="other" />
    );
    expect(
      screen.getByText("Other").closest('[role="treeitem"]')
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByText("Changed child").closest('[role="treeitem"]')
    ).not.toHaveAttribute("aria-selected");
  });
});
