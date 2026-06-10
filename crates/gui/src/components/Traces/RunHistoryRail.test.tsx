import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunHistoryRail } from "./RunHistoryRail";
import { createMockTask, createMockTaskRun } from "../../test/test-utils";
import type { Thread } from "../thread/types";

function activeThreads(): Thread[] {
  return [
    {
      id: "th-1",
      step: { to: "accept_user_turn", kind: "execute", at: "01:13:42" },
      summary: { turns: 2, tools: 3, status: "ok" },
      turns: [
        {
          id: "t0",
          messages: [
            {
              type: "spawn",
              evt: "spawn-1",
              thread: {
                id: "sub-1",
                label: "write_failing_test",
                kind: "execute",
                spawnLabel: "subagent",
                summary: { turns: 1, tools: 1, status: "ok" },
                turns: [{ id: "st0", messages: [] }],
              },
            },
          ],
        },
      ],
    },
    {
      id: "th-2",
      step: { to: "verify_changes", kind: "execute", at: "01:22:40" },
      summary: { turns: 1, tools: 1, status: "ok" },
      turns: [{ id: "t0", messages: [] }],
    },
  ];
}

const baseProps = {
  tasks: [createMockTask({ id: "root", title: "Root" })],
  currentTaskId: "root",
  activeRunSource: "active" as const,
  onSelectTask: vi.fn(),
  onSelectRun: vi.fn(),
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("RunHistoryRail (flat run history)", () => {
  it("groups the task's runs by day", () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
    const runs = [
      createMockTaskRun({
        id: "run-today",
        task_id: "root",
        started_at: now.toISOString(),
      }),
      createMockTaskRun({
        id: "run-yesterday",
        task_id: "root",
        started_at: yesterday.toISOString(),
      }),
    ];
    render(
      <RunHistoryRail {...baseProps} runs={runs} activeRunId="run-today" />
    );
    const labels = screen
      .getAllByTestId("run-history-day-label")
      .map((el) => el.textContent);
    expect(labels).toContain("Today");
    expect(labels).toContain("Yesterday");
  });

  it("renders one run-history row per run", () => {
    const runs = [
      createMockTaskRun({ id: "run-1", task_id: "root" }),
      createMockTaskRun({ id: "run-2", task_id: "root" }),
    ];
    render(<RunHistoryRail {...baseProps} runs={runs} activeRunId="run-1" />);
    expect(screen.getAllByTestId("run-history-row")).toHaveLength(2);
  });

  it("expands the active run into flattened thread nodes", () => {
    const runs = [createMockTaskRun({ id: "run-1", task_id: "root" })];
    render(
      <RunHistoryRail
        {...baseProps}
        runs={runs}
        activeRunId="run-1"
        activeRunThreads={activeThreads()}
      />
    );
    const nodes = screen.getAllByTestId("run-history-trace-thread");
    // 2 root threads + 1 nested subagent = 3 flattened nodes.
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.getAttribute("data-thread-id"))).toEqual([
      "th-1",
      "sub-1",
      "th-2",
    ]);
  });

  it("does not expand a non-active run", () => {
    const runs = [
      createMockTaskRun({ id: "run-1", task_id: "root" }),
      createMockTaskRun({ id: "run-2", task_id: "root" }),
    ];
    render(
      <RunHistoryRail
        {...baseProps}
        runs={runs}
        activeRunId="run-2"
        activeRunThreads={activeThreads()}
      />
    );
    // Only the active run (run-2, empty threads here) expands; run-1 stays flat.
    expect(screen.queryAllByTestId("run-history-trace-thread")).toHaveLength(3);
  });

  it("calls onJump when a thread node is clicked", () => {
    const onJump = vi.fn();
    const runs = [createMockTaskRun({ id: "run-1", task_id: "root" })];
    render(
      <RunHistoryRail
        {...baseProps}
        runs={runs}
        activeRunId="run-1"
        activeRunThreads={activeThreads()}
        onJump={onJump}
      />
    );
    fireEvent.click(screen.getAllByTestId("run-history-trace-thread")[1]);
    expect(onJump).toHaveBeenCalledWith("sub-1");
  });

  it("marks the selected thread node", () => {
    const runs = [createMockTaskRun({ id: "run-1", task_id: "root" })];
    render(
      <RunHistoryRail
        {...baseProps}
        runs={runs}
        activeRunId="run-1"
        activeRunThreads={activeThreads()}
        selectedEvt="th-2"
      />
    );
    const node = screen
      .getAllByTestId("run-history-trace-thread")
      .find((n) => n.getAttribute("data-thread-id") === "th-2");
    expect(node?.getAttribute("data-selected")).toBe("true");
  });

  it("keeps the TASKS tree section", () => {
    render(<RunHistoryRail {...baseProps} runs={[]} activeRunId={null} />);
    expect(screen.getByTestId("run-history-tasks-section")).toBeInTheDocument();
    expect(screen.getByTestId("run-history-task-row")).toBeInTheDocument();
  });

  it("collapses and expands", () => {
    const { rerender } = render(
      <RunHistoryRail {...baseProps} runs={[]} activeRunId={null} collapsed />
    );
    expect(
      screen.getByTestId("run-history-rail").getAttribute("data-collapsed")
    ).toBe("true");
    rerender(
      <RunHistoryRail
        {...baseProps}
        runs={[]}
        activeRunId={null}
        collapsed={false}
      />
    );
    expect(
      screen.getByTestId("run-history-rail").getAttribute("data-collapsed")
    ).toBe("false");
  });
});
