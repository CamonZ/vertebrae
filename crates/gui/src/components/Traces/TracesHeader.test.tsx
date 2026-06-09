import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "../../test/test-utils";
import { TracesHeader } from "./TracesHeader";

const baseRollups = {
  totalRuns: 7,
  totalAttempts: 11,
  totalCost: 1.2345,
  totalTokens: 12345,
  rawInputTokens: 3000,
  cacheReadTokens: 8000,
  outputTokens: 1345,
  totalWallTimeMs: 65 * 1000, // 1m 5s
};

describe("TracesHeader", () => {
  it("renders title, level, and hero stats", () => {
    render(
      <TracesHeader
        taskId="task-1"
        title="Refactor auth"
        level="ticket"
        runState="waiting"
        rollups={baseRollups}
      />
    );
    expect(screen.getByTestId("traces-title").textContent).toBe(
      "Refactor auth"
    );
    expect(screen.getByTestId("traces-breadcrumb-level").textContent).toBe(
      "ticket"
    );
    expect(screen.getByTestId("traces-hero-state").textContent).toMatch(
      /Waiting/i
    );
    expect(screen.getByTestId("traces-hero-runs").textContent).toMatch(/7/);
    // Executions are a separate stat so callers don't confuse retries with runs.
    expect(screen.getByTestId("traces-hero-executions").textContent).toMatch(
      /11/
    );
    expect(screen.getByTestId("traces-hero-tokens").textContent).toMatch(/12k/);
    // Raw / cache / output breakdown is surfaced alongside the grand total.
    expect(screen.getByTestId("traces-hero-tokens-raw").textContent).toMatch(
      /3k raw/
    );
    expect(screen.getByTestId("traces-hero-tokens-cache").textContent).toMatch(
      /8k cache/
    );
    expect(screen.getByTestId("traces-hero-tokens-output").textContent).toMatch(
      /1k out/
    );
    expect(screen.getByTestId("traces-hero-runtime").textContent).toMatch(
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

  it("does not render the Detach button even when onDetach is provided (temporarily disabled)", () => {
    const onDetach = vi.fn();
    render(
      <TracesHeader
        taskId="task-1"
        title="X"
        level="task"
        rollups={baseRollups}
        onDetach={onDetach}
      />
    );
    expect(screen.queryByTestId("traces-detach-button")).toBeNull();
  });

  it("hides the Detach button when no onDetach is provided", () => {
    render(
      <TracesHeader
        taskId="task-1"
        title="X"
        level="task"
        rollups={baseRollups}
      />
    );
    expect(screen.queryByTestId("traces-detach-button")).toBeNull();
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
    expect(screen.getByTestId("traces-hero-error").textContent).toBe("boom");
  });
});
