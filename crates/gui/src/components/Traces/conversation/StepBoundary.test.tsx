import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StepBoundary } from "./StepBoundary";

describe("StepBoundary", () => {
  const baseProps = {
    executionId: "exec-1",
    taskId: "task-1",
    workflowName: "Implementation",
    stepName: "in_progress",
    startedAt: "2026-01-15T13:45:30.000Z",
    model: "claude-opus-4-7",
    costUsd: 0.1234,
  };

  it("renders workflow name, humanized step, and exposes data attrs", () => {
    render(<StepBoundary {...baseProps} taskTitle="Build the thing" />);
    const el = screen.getByTestId("unified-chat-step-boundary");
    expect(el.getAttribute("data-execution-id")).toBe("exec-1");
    expect(el.getAttribute("data-task-id")).toBe("task-1");
    expect(el.getAttribute("data-step-name")).toBe("in_progress");
    expect(el.getAttribute("data-depth")).toBe("0");
    expect(screen.getByText("Implementation")).toBeInTheDocument();
    expect(screen.getByText("in progress")).toBeInTheDocument();
    expect(screen.getByText("Build the thing")).toBeInTheDocument();
    expect(screen.getByText("claude-opus-4-7")).toBeInTheDocument();
  });

  it("falls back to 'workflow' / 'step' when names are null", () => {
    render(
      <StepBoundary
        {...baseProps}
        workflowName={null}
        stepName={null}
        startedAt={null}
        model={null}
        costUsd={null}
      />
    );
    expect(screen.getByText("workflow")).toBeInTheDocument();
    expect(screen.getByText("step")).toBeInTheDocument();
  });

  it("omits cost when null or zero", () => {
    const { rerender } = render(
      <StepBoundary {...baseProps} costUsd={null} />
    );
    expect(screen.queryByText(/\$/)).toBeNull();
    rerender(<StepBoundary {...baseProps} costUsd={0} />);
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("indents 16px per depth level", () => {
    render(<StepBoundary {...baseProps} depth={2} />);
    const el = screen.getByTestId("unified-chat-step-boundary");
    expect(el.style.marginLeft).toBe("32px");
    expect(el.getAttribute("data-depth")).toBe("2");
  });
});
