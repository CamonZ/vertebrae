import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Task, TaskRunStatus } from "../../bindings";
import type { TaskTreeNode as TaskTreeNodeType } from "../../types/ui";
import { TaskTreeView } from "./TaskTreeView";

function createTask(overrides?: Partial<Task>): Task {
  return {
    id: "feedface-0000-0000-0000-000000000000",
    title: "Test Task",
    description: null,
    level: "task",
    priority: null,
    tags: [],
    workflow_id: null,
    current_step_id: null,
    workflow_name: null,
    step_name: null,
    archived: false,
    worktree: null,
    rejection_reason: null,
    parent_id: null,
    dependency_ids: [],
    sections: [],
    code_refs: [],
    run_controls: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function node(task: Task, children: TaskTreeNodeType[] = []): TaskTreeNodeType {
  return { task, has_blockers: false, blocker_count: 0, children };
}

function renderTree(hierarchy: TaskTreeNodeType[]) {
  return render(
    <TaskTreeView hierarchy={hierarchy} isLoading={false} error={null} />
  );
}

function withActiveRun(task: Task, status: TaskRunStatus, startedAt: string) {
  return createTask({
    ...task,
    run_controls: {
      runnable: false,
      stoppable: status !== "stopping",
      disabled_reason_code: null,
      disabled_reason: null,
      active_run: {
        id: `run-${task.id}`,
        task_id: task.id,
        project_id: "project-1",
        user_id: null,
        status,
        started_at: startedAt,
        ended_at: null,
        stop_requested_at: null,
        latest_step_execution_id: null,
        outcome_kind: null,
        outcome_context: null,
        parent_task_run_id: null,
        root_task_run_id: null,
        triggered_by_step_execution_id: null,
        inserted_at: startedAt,
        updated_at: startedAt,
      },
    },
  });
}

describe("TaskTreeNode", () => {
  it("renders the title and a metadata line carrying the short ID with copy", () => {
    renderTree([
      node(
        createTask({
          id: "feedface-1234-5678-9abc-def012345678",
          title: "Two line layout task",
        })
      ),
    ]);

    expect(screen.getByText("Two line layout task")).toBeInTheDocument();

    const idBadge = screen.getByTestId("task-tree-node-id");
    expect(idBadge).toHaveTextContent("feedface");
    expect(idBadge).not.toHaveTextContent(
      "feedface-1234-5678-9abc-def012345678"
    );
    // Copy affordance is preserved.
    expect(
      within(idBadge).getByRole("button", { name: /copy full/i })
    ).toBeInTheDocument();
  });

  it("renders a level glyph keyed to the task level", () => {
    renderTree([
      node(
        createTask({
          id: "a0000000-0000-0000-0000-000000000001",
          level: "epic",
        })
      ),
      node(
        createTask({
          id: "a0000000-0000-0000-0000-000000000002",
          level: "ticket",
        })
      ),
      node(
        createTask({
          id: "a0000000-0000-0000-0000-000000000003",
          level: "task",
        })
      ),
    ]);

    const glyphs = screen.getAllByTestId("task-tree-node-level-glyph");
    expect(glyphs).toHaveLength(3);
    expect(glyphs[0]).toHaveAttribute("data-level", "epic");
    expect(
      glyphs[0].querySelector('[data-shape="diamond-filled"]')
    ).toBeInTheDocument();
    expect(glyphs[1]).toHaveAttribute("data-level", "ticket");
    expect(
      glyphs[1].querySelector('[data-shape="diamond-hollow"]')
    ).toBeInTheDocument();
    expect(glyphs[2]).toHaveAttribute("data-level", "task");
    expect(glyphs[2].querySelector('[data-shape="dot"]')).toBeInTheDocument();
  });

  it("shows a pluralized child-level summary using the child level", () => {
    const childA = node(
      createTask({
        id: "c0000000-0000-0000-0000-000000000001",
        level: "ticket",
      })
    );
    const childB = node(
      createTask({
        id: "c0000000-0000-0000-0000-000000000002",
        level: "ticket",
      })
    );
    renderTree([
      node(
        createTask({
          id: "e0000000-0000-0000-0000-000000000000",
          level: "epic",
        }),
        [childA, childB]
      ),
    ]);

    expect(
      screen.getByTestId("task-tree-node-child-summary")
    ).toHaveTextContent("2 tickets");
  });

  it("singularizes the child summary for a single child", () => {
    const child = node(
      createTask({ id: "c1000000-0000-0000-0000-000000000001", level: "task" })
    );
    renderTree([
      node(
        createTask({
          id: "t1000000-0000-0000-0000-000000000000",
          level: "ticket",
        }),
        [child]
      ),
    ]);

    expect(
      screen.getByTestId("task-tree-node-child-summary")
    ).toHaveTextContent("1 task");
  });

  it("renders each tag as a pill in the metadata line", () => {
    renderTree([node(createTask({ tags: ["backend", "urgent"] }))]);

    const pills = screen.getAllByTestId("task-tree-node-tag");
    expect(pills.map((p) => p.textContent)).toEqual(["backend", "urgent"]);
  });

  it("renders priority as a directional arrow on the right", () => {
    renderTree([
      node(
        createTask({
          id: "p0000000-0000-0000-0000-000000000001",
          priority: "high",
        })
      ),
      node(
        createTask({
          id: "p0000000-0000-0000-0000-000000000002",
          priority: "medium",
        })
      ),
      node(
        createTask({
          id: "p0000000-0000-0000-0000-000000000003",
          priority: "low",
        })
      ),
    ]);

    const arrows = screen.getAllByTestId("task-tree-node-priority");
    expect(arrows[0]).toHaveAttribute("data-priority", "high");
    expect(arrows[0]).toHaveTextContent("↑");
    expect(arrows[1]).toHaveAttribute("data-priority", "medium");
    expect(arrows[1]).toHaveTextContent("→");
    expect(arrows[2]).toHaveAttribute("data-priority", "low");
    expect(arrows[2]).toHaveTextContent("↓");
  });

  it("renders no priority arrow when priority is unset", () => {
    renderTree([node(createTask({ priority: null }))]);
    expect(
      screen.queryByTestId("task-tree-node-priority")
    ).not.toBeInTheDocument();
  });

  it("shows the Hearth run chip with the workflow step while a run is active", () => {
    renderTree([
      node(
        withActiveRun(
          createTask({ title: "Running", step_name: "in_progress" }),
          "executing",
          "2025-01-01T00:00:00Z"
        )
      ),
    ]);

    const chip = screen.getByTestId("task-tree-node-run-chip");
    expect(chip).toHaveAttribute("data-run-status", "executing");
    expect(chip).toHaveAttribute("data-state", "running");
    expect(chip).toHaveAttribute("aria-label", "Run status: Running");
    expect(chip).toHaveTextContent("Running");
    // The neutral workflow|step breadcrumb remains beside the live chip.
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("shows the workflow step for idle tasks without rendering a run chip", () => {
    renderTree([
      node(
        createTask({
          workflow_name: "Implementation",
          step_name: "todo",
          run_controls: null,
        })
      ),
    ]);

    expect(
      screen.queryByTestId("task-tree-node-run-chip")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Implementation")).not.toBeInTheDocument();
    expect(screen.getByText("Todo")).toBeInTheDocument();
  });

  it("marks the selected row with aria-selected and a selected data flag", () => {
    const selected = createTask({
      id: "5e1ec7ed-0000-0000-0000-000000000000",
      title: "Selected",
    });
    const other = createTask({
      id: "0therrow-0000-0000-0000-000000000000",
      title: "Other",
    });

    render(
      <TaskTreeView
        hierarchy={[node(selected), node(other)]}
        isLoading={false}
        error={null}
        selectedTaskId={selected.id}
      />
    );

    const rows = screen.getAllByTestId("task-tree-node-row");
    const selectedRows = rows.filter(
      (row) => row.getAttribute("data-selected") === "true"
    );
    expect(selectedRows).toHaveLength(1);
    expect(selectedRows[0]).toHaveAttribute("aria-selected", "true");
    expect(selectedRows[0]).toHaveTextContent("Selected");
  });

  it("moves selection to the next visible row with ArrowDown", () => {
    const first = createTask({
      id: "10000000-0000-0000-0000-000000000000",
      title: "First",
    });
    const second = createTask({
      id: "20000000-0000-0000-0000-000000000000",
      title: "Second",
    });
    const onTaskSelect = vi.fn();

    render(
      <TaskTreeView
        hierarchy={[node(first), node(second)]}
        isLoading={false}
        error={null}
        selectedTaskId={first.id}
        onTaskSelect={onTaskSelect}
      />
    );

    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });

    expect(onTaskSelect).toHaveBeenCalledTimes(1);
    expect(onTaskSelect).toHaveBeenCalledWith(second);
  });
});
