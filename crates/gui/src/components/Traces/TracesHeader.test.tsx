import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "../../test/test-utils";
import { TracesHeader } from "./TracesHeader";

const baseRollups = {
  totalRuns: 7,
  totalCost: 1.2345,
  totalTokens: 12345,
  totalWallTimeMs: 65 * 1000, // 1m 5s
};

describe("TracesHeader", () => {
  it("renders title, level, and rollup values", () => {
    render(
      <TracesHeader
        taskId="task-1"
        title="Refactor auth"
        level="ticket"
        rollups={baseRollups}
      />
    );
    expect(screen.getByTestId("traces-title").textContent).toBe(
      "Refactor auth"
    );
    expect(screen.getByTestId("traces-breadcrumb-level").textContent).toBe(
      "ticket"
    );
    expect(screen.getByTestId("traces-rollup-runs").textContent).toMatch(/7/);
    expect(screen.getByTestId("traces-rollup-cost").textContent).toMatch(
      /\$1\.23/
    );
    expect(screen.getByTestId("traces-rollup-tokens").textContent).toMatch(
      /12\.3k/
    );
    expect(screen.getByTestId("traces-rollup-walltime").textContent).toMatch(
      /1m 5s/
    );
  });

  it("falls back gracefully when title or level are missing", () => {
    render(
      <TracesHeader
        taskId="task-1"
        title={null}
        level={null}
        rollups={baseRollups}
      />
    );
    expect(screen.getByTestId("traces-title").textContent).toBe(
      "Unknown task"
    );
    expect(screen.getByTestId("traces-breadcrumb-level").textContent).toBe(
      "task"
    );
  });

  it("calls onBack when the back button is clicked", () => {
    const onBack = vi.fn();
    render(
      <TracesHeader
        taskId="task-1"
        title="X"
        level="task"
        rollups={baseRollups}
        onBack={onBack}
      />
    );
    fireEvent.click(screen.getByTestId("traces-back-button"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("hides the back button when no onBack is provided", () => {
    render(
      <TracesHeader
        taskId="task-1"
        title="X"
        level="task"
        rollups={baseRollups}
      />
    );
    expect(screen.queryByTestId("traces-back-button")).toBeNull();
  });

  it("renders an error pill when error is set and not loading", () => {
    render(
      <TracesHeader
        taskId="task-1"
        title="X"
        level="task"
        rollups={baseRollups}
        error="boom"
      />
    );
    expect(screen.getByTestId("traces-rollup-error").textContent).toBe("boom");
  });
});
