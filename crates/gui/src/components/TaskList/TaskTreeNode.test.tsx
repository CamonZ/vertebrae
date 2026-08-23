import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Task, TaskRunStatus } from "../../bindings";
import type { TaskTreeNode as TaskTreeNodeType } from "../../types/ui";
import { TaskTreeView } from "./TaskTreeView";
import { useExpandedNodes } from "../../hooks/useExpandedNodes";
import { useSummaryExpanded } from "../../hooks/useSummaryExpanded";

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
    step_type: null,
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
    // Copy affordance is preserved — the chip itself is the copy control.
    expect(idBadge).toHaveAttribute("role", "button");
    expect(idBadge).toHaveAccessibleName(/copy full/i);
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

  it("shows the Hearth run chip while a run is active", () => {
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
  });

  it("renders neither a run chip nor a workflow/step label for idle tasks", () => {
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
    expect(screen.queryByText("Todo")).not.toBeInTheDocument();
  });

  it("shows a completion ✓ (not a run chip) for a task with completed_at, even after a completed run", () => {
    renderTree([
      node(
        withActiveRun(
          createTask({
            title: "Done run",
            completed_at: "2025-01-01T00:00:00Z",
          }),
          "completed",
          "2025-01-01T00:00:00Z"
        )
      ),
    ]);

    expect(
      screen.queryByTestId("task-tree-node-run-chip")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("task-tree-node-done-mark")).toHaveAttribute(
      "aria-label",
      "Completed"
    );
  });

  it("shows a completion ✓ for a task with completed_at and no active run", () => {
    renderTree([
      node(
        createTask({
          title: "Completed, never ran",
          completed_at: "2025-01-01T00:00:00Z",
        })
      ),
    ]);

    expect(
      screen.queryByTestId("task-tree-node-run-chip")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("task-tree-node-done-mark")).toHaveAttribute(
      "aria-label",
      "Completed"
    );
  });

  it("shows no completion mark when completed_at is unset (done step alone is not enough)", () => {
    renderTree([node(createTask({ title: "Done step", step_name: "done" }))]);

    expect(
      screen.queryByTestId("task-tree-node-done-mark")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("task-tree-node-cancel-mark")
    ).not.toBeInTheDocument();
  });

  it("does not treat terminal history as active task-list state", () => {
    renderTree([
      node(
        withActiveRun(
          createTask({ id: "stopped-task", title: "Stopped run" }),
          "stopped",
          "2025-01-01T00:00:00Z"
        )
      ),
      node(
        withActiveRun(
          createTask({ id: "failed-task", title: "Failed run" }),
          "failed",
          "2025-01-01T00:00:00Z"
        )
      ),
    ]);

    expect(
      screen.queryByTestId("task-tree-node-cancel-mark")
    ).not.toBeInTheDocument();
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
    expect(selectedRows[0]).toHaveClass("t-row", "sel");
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

// ── Done-task list controls (hide-done + done summary) ─────────────
function doneTask(id: string, title: string): Task {
  return createTask({ id, title, completed_at: "2025-01-02T00:00:00Z" });
}

/**
 * Renders the tree with the real expansion + summary hooks wired up, with the
 * given parent ids expanded so child controls are exercised against live
 * state. `onTaskSelect` is provided so keyboard navigation is active.
 */
function Harness({
  hierarchy,
  hideCompleted = false,
  filtering = false,
  expandIds = [],
  selectedTaskId,
  onTaskSelect = () => {},
}: {
  hierarchy: TaskTreeNodeType[];
  hideCompleted?: boolean;
  filtering?: boolean;
  expandIds?: string[];
  selectedTaskId?: string | null;
  onTaskSelect?: (task: Task) => void;
}) {
  const expandedNodes = useExpandedNodes();
  const summaryExpanded = useSummaryExpanded();
  if (expandIds.length && expandedNodes.expandedNodeIds.size === 0) {
    expandedNodes.expandAll(expandIds);
  }
  return (
    <TaskTreeView
      hierarchy={hierarchy}
      isLoading={false}
      error={null}
      selectedTaskId={selectedTaskId}
      onTaskSelect={onTaskSelect}
      expandedNodes={expandedNodes}
      summaryExpanded={summaryExpanded}
      hideCompleted={hideCompleted}
      filtering={filtering}
    />
  );
}

describe("hide-done + done summary controls", () => {
  it("hides completed LEAVES but keeps completed parents and open tasks", () => {
    const completedParent = node(
      doneTask("d1000000-0000-0000-0000-000000000000", "Done parent"),
      [
        node(
          createTask({
            id: "d1c00000-0000-0000-0000-000000000000",
            title: "Open grandchild",
          })
        ),
      ]
    );
    const hierarchy: TaskTreeNodeType[] = [
      node(
        createTask({
          id: "e0000000-0000-0000-0000-00000000000a",
          title: "Root",
          level: "epic",
        }),
        [
          node(
            createTask({
              id: "00pen000-0000-0000-0000-000000000000",
              title: "Open leaf",
            })
          ),
          node(doneTask("d0000000-0000-0000-0000-000000000000", "Done leaf")),
          completedParent,
        ]
      ),
    ];

    render(
      <Harness
        hierarchy={hierarchy}
        hideCompleted
        expandIds={[
          "e0000000-0000-0000-0000-00000000000a",
          "d1000000-0000-0000-0000-000000000000",
        ]}
      />
    );

    expect(screen.getByText("Open leaf")).toBeInTheDocument();
    expect(screen.getByText("Done parent")).toBeInTheDocument();
    expect(screen.getByText("Open grandchild")).toBeInTheDocument();
    expect(screen.queryByText("Done leaf")).not.toBeInTheDocument();
  });

  it("does nothing while filtering: a done leaf still renders", () => {
    const hierarchy: TaskTreeNodeType[] = [
      node(
        createTask({
          id: "e0000000-0000-0000-0000-00000000000b",
          title: "Root",
        }),
        [node(doneTask("d0000000-0000-0000-0000-000000000001", "Done leaf"))]
      ),
    ];

    render(
      <Harness
        hierarchy={hierarchy}
        hideCompleted
        filtering
        expandIds={["e0000000-0000-0000-0000-00000000000b"]}
      />
    );

    // hide-done is on, but filtering bypasses it.
    expect(screen.getByText("Done leaf")).toBeInTheDocument();
  });

  it("collapses >= 3 done leaves into a single '{n} completed' summary row", () => {
    const root = createTask({
      id: "e0000000-0000-0000-0000-00000000000c",
      title: "Root",
    });
    const hierarchy: TaskTreeNodeType[] = [
      node(root, [
        node(
          createTask({
            id: "0pen0000-0000-0000-0000-000000000000",
            title: "Open leaf",
          })
        ),
        node(doneTask("d0000000-0000-0000-0000-000000000010", "Done one")),
        node(doneTask("d0000000-0000-0000-0000-000000000011", "Done two")),
        node(doneTask("d0000000-0000-0000-0000-000000000012", "Done three")),
      ]),
    ];

    render(<Harness hierarchy={hierarchy} expandIds={[root.id]} />);

    const summary = screen.getByTestId("task-tree-summary-row");
    expect(summary).toHaveTextContent("3 completed");
    expect(screen.getByText("Open leaf")).toBeInTheDocument();
    expect(screen.queryByText("Done one")).not.toBeInTheDocument();
    expect(screen.queryByText("Done three")).not.toBeInTheDocument();
  });

  it("does NOT collapse when there are fewer than 3 done leaves", () => {
    const root = createTask({
      id: "e0000000-0000-0000-0000-00000000000d",
      title: "Root",
    });
    const hierarchy: TaskTreeNodeType[] = [
      node(root, [
        node(doneTask("d0000000-0000-0000-0000-000000000020", "Done one")),
        node(doneTask("d0000000-0000-0000-0000-000000000021", "Done two")),
      ]),
    ];

    render(<Harness hierarchy={hierarchy} expandIds={[root.id]} />);

    expect(
      screen.queryByTestId("task-tree-summary-row")
    ).not.toBeInTheDocument();
    expect(screen.getByText("Done one")).toBeInTheDocument();
    expect(screen.getByText("Done two")).toBeInTheDocument();
  });

  it("toggles the folded done leaves when the summary row is clicked", () => {
    const root = createTask({
      id: "e0000000-0000-0000-0000-00000000000e",
      title: "Root",
    });
    const hierarchy: TaskTreeNodeType[] = [
      node(root, [
        node(doneTask("d0000000-0000-0000-0000-000000000030", "Done one")),
        node(doneTask("d0000000-0000-0000-0000-000000000031", "Done two")),
        node(doneTask("d0000000-0000-0000-0000-000000000032", "Done three")),
      ]),
    ];

    render(<Harness hierarchy={hierarchy} expandIds={[root.id]} />);

    const summary = screen.getByTestId("task-tree-summary-row");
    expect(screen.queryByText("Done one")).not.toBeInTheDocument();
    expect(summary).toHaveTextContent("show");

    fireEvent.click(summary);

    expect(screen.getByText("Done one")).toBeInTheDocument();
    expect(screen.getByText("Done three")).toBeInTheDocument();
    expect(screen.getByTestId("task-tree-summary-row")).toHaveTextContent(
      "hide"
    );

    fireEvent.click(screen.getByTestId("task-tree-summary-row"));
    expect(screen.queryByText("Done one")).not.toBeInTheDocument();
  });

  it("bypasses collapse when hide-done is on (leaves hidden, no summary)", () => {
    const root = createTask({
      id: "e0000000-0000-0000-0000-00000000000f",
      title: "Root",
    });
    const hierarchy: TaskTreeNodeType[] = [
      node(root, [
        node(doneTask("d0000000-0000-0000-0000-000000000040", "Done one")),
        node(doneTask("d0000000-0000-0000-0000-000000000041", "Done two")),
        node(doneTask("d0000000-0000-0000-0000-000000000042", "Done three")),
      ]),
    ];

    render(
      <Harness hierarchy={hierarchy} hideCompleted expandIds={[root.id]} />
    );

    expect(
      screen.queryByTestId("task-tree-summary-row")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Done one")).not.toBeInTheDocument();
  });

  it("bypasses collapse when filtering (all done leaves render, no summary)", () => {
    const root = createTask({
      id: "e0000000-0000-0000-0000-000000000010",
      title: "Root",
    });
    const hierarchy: TaskTreeNodeType[] = [
      node(root, [
        node(doneTask("d0000000-0000-0000-0000-000000000050", "Done one")),
        node(doneTask("d0000000-0000-0000-0000-000000000051", "Done two")),
        node(doneTask("d0000000-0000-0000-0000-000000000052", "Done three")),
      ]),
    ];

    render(<Harness hierarchy={hierarchy} filtering expandIds={[root.id]} />);

    expect(
      screen.queryByTestId("task-tree-summary-row")
    ).not.toBeInTheDocument();
    expect(screen.getByText("Done one")).toBeInTheDocument();
    expect(screen.getByText("Done three")).toBeInTheDocument();
  });

  it("ArrowDown skips hidden done leaves during keyboard navigation", () => {
    const open1 = createTask({
      id: "a0000000-0000-0000-0000-0000000000a1",
      title: "Open A",
    });
    const open2 = createTask({
      id: "a0000000-0000-0000-0000-0000000000a2",
      title: "Open B",
    });
    const root = createTask({
      id: "a0000000-0000-0000-0000-0000000000a0",
      title: "Root",
    });
    const hierarchy: TaskTreeNodeType[] = [
      node(root, [
        node(open1),
        node(doneTask("a0000000-0000-0000-0000-0000000000d1", "Hidden done")),
        node(open2),
      ]),
    ];
    const onTaskSelect = vi.fn();

    render(
      <Harness
        hierarchy={hierarchy}
        hideCompleted
        expandIds={[root.id]}
        selectedTaskId={open1.id}
        onTaskSelect={onTaskSelect}
      />
    );

    // From the first open child, ArrowDown must land on the second open child,
    // skipping the hidden done leaf in between.
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    expect(onTaskSelect).toHaveBeenCalledWith(open2);
  });

  it("ArrowDown skips collapsed done leaves, landing on the next real row", () => {
    const root = createTask({
      id: "b0000000-0000-0000-0000-0000000000b0",
      title: "Root",
    });
    const open1 = createTask({
      id: "b0000000-0000-0000-0000-0000000000b1",
      title: "Open A",
    });
    const sibling = createTask({
      id: "b0000000-0000-0000-0000-0000000000b9",
      title: "Sibling root",
    });
    const hierarchy: TaskTreeNodeType[] = [
      node(root, [
        node(open1),
        node(doneTask("b0000000-0000-0000-0000-0000000000d1", "Done one")),
        node(doneTask("b0000000-0000-0000-0000-0000000000d2", "Done two")),
        node(doneTask("b0000000-0000-0000-0000-0000000000d3", "Done three")),
      ]),
      node(sibling),
    ];
    const onTaskSelect = vi.fn();

    render(
      <Harness
        hierarchy={hierarchy}
        expandIds={[root.id]}
        selectedTaskId={open1.id}
        onTaskSelect={onTaskSelect}
      />
    );

    // The 3 done leaves are folded behind a (non-selectable) summary row; from
    // "Open A" the next selectable row is the sibling root.
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    expect(onTaskSelect).toHaveBeenCalledWith(sibling);
  });

  // Mirrors the production bug: when an archived/filtered-out parent epic is
  // absent from the loaded set, its completed children are re-parented to the
  // root by buildTreeFromTasks. Root-level completed siblings must still fold.
  it("collapses >= 3 completed ROOT-level siblings into a summary row", () => {
    const hierarchy: TaskTreeNodeType[] = [
      node(
        createTask({
          id: "f0000000-0000-0000-0000-000000000000",
          title: "Open root",
        })
      ),
      node(doneTask("f0000000-0000-0000-0000-000000000001", "Orphan done one")),
      node(doneTask("f0000000-0000-0000-0000-000000000002", "Orphan done two")),
      node(
        doneTask("f0000000-0000-0000-0000-000000000003", "Orphan done three")
      ),
    ];

    render(<Harness hierarchy={hierarchy} />);

    expect(screen.getByTestId("task-tree-summary-row")).toHaveTextContent(
      "3 completed"
    );
    expect(screen.getByText("Open root")).toBeInTheDocument();
    expect(screen.queryByText("Orphan done one")).not.toBeInTheDocument();
    expect(screen.queryByText("Orphan done three")).not.toBeInTheDocument();
  });

  it("toggles the folded ROOT-level done siblings when the summary is clicked", () => {
    const hierarchy: TaskTreeNodeType[] = [
      node(doneTask("f1000000-0000-0000-0000-000000000001", "Root done one")),
      node(doneTask("f1000000-0000-0000-0000-000000000002", "Root done two")),
      node(doneTask("f1000000-0000-0000-0000-000000000003", "Root done three")),
    ];

    render(<Harness hierarchy={hierarchy} />);

    const summary = screen.getByTestId("task-tree-summary-row");
    expect(screen.queryByText("Root done one")).not.toBeInTheDocument();

    fireEvent.click(summary);

    expect(screen.getByText("Root done one")).toBeInTheDocument();
    expect(screen.getByText("Root done three")).toBeInTheDocument();
  });

  it("folds a fully-complete ROOT epic (all children done) at the top level", () => {
    // A completed top-level epic whose entire subtree is done participates in
    // the root collapse, alongside completed orphan leaves.
    const completedEpic = node(
      doneTask("f2000000-0000-0000-0000-000000000000", "Done epic"),
      [
        node(doneTask("f2c00000-0000-0000-0000-000000000001", "Done child")),
        node(doneTask("f2c00000-0000-0000-0000-000000000002", "Done child 2")),
      ]
    );
    const hierarchy: TaskTreeNodeType[] = [
      completedEpic,
      node(doneTask("f2000000-0000-0000-0000-000000000003", "Done leaf one")),
      node(doneTask("f2000000-0000-0000-0000-000000000004", "Done leaf two")),
    ];

    render(
      <Harness
        hierarchy={hierarchy}
        expandIds={["f2000000-0000-0000-0000-000000000000"]}
      />
    );

    expect(screen.getByTestId("task-tree-summary-row")).toHaveTextContent(
      "3 completed"
    );
    expect(screen.queryByText("Done epic")).not.toBeInTheDocument();
    expect(screen.queryByText("Done child")).not.toBeInTheDocument();
  });
});
