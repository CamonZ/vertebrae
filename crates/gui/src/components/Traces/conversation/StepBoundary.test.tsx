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
    // Step label is now prefixed with the play glyph
    expect(screen.getByText(/in progress/)).toBeInTheDocument();
    expect(screen.getByText("Build the thing")).toBeInTheDocument();
    expect(screen.getByText("claude-opus-4-7")).toBeInTheDocument();
  });

  it("renders folded session facts (duration, turns, cost) in the divider", () => {
    render(
      <StepBoundary
        {...baseProps}
        durationMs={125000}
        numTurns={3}
        costUsd={0.42}
      />
    );
    expect(screen.getByTestId("step-boundary-duration").textContent).toBe(
      "2m 5s"
    );
    expect(screen.getByTestId("step-boundary-turns").textContent).toBe(
      "3 turns"
    );
    expect(screen.getByTestId("step-boundary-cost").textContent).toBe(
      "$0.42"
    );
  });

  it("singularizes 'turn' for a single-turn execution", () => {
    render(<StepBoundary {...baseProps} numTurns={1} />);
    expect(screen.getByTestId("step-boundary-turns").textContent).toBe("1 turn");
  });

  it("hides the task title when placement is 'hidden' (single-task scope)", () => {
    render(
      <StepBoundary
        {...baseProps}
        taskTitle="Redundant title"
        taskTitlePlacement="hidden"
      />
    );
    expect(screen.queryByText("Redundant title")).toBeNull();
    expect(screen.queryByTestId("step-boundary-task-title")).toBeNull();
    expect(screen.queryByTestId("step-boundary-task-subtitle")).toBeNull();
  });

  it("renders the task title on a subtitle line when placement is 'subtitle' (delegation)", () => {
    render(
      <StepBoundary
        {...baseProps}
        taskTitle="Child Task Title"
        taskTitlePlacement="subtitle"
      />
    );
    const subtitle = screen.getByTestId("step-boundary-task-subtitle");
    expect(subtitle.textContent).toBe("Child Task Title");
    expect(screen.queryByTestId("step-boundary-task-title")).toBeNull();
  });

  it("omits duration/turns when null or zero", () => {
    const { rerender } = render(
      <StepBoundary {...baseProps} durationMs={null} numTurns={null} />
    );
    expect(screen.queryByTestId("step-boundary-duration")).toBeNull();
    expect(screen.queryByTestId("step-boundary-turns")).toBeNull();
    rerender(<StepBoundary {...baseProps} durationMs={0} numTurns={0} />);
    expect(screen.queryByTestId("step-boundary-duration")).toBeNull();
    expect(screen.queryByTestId("step-boundary-turns")).toBeNull();
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
    // Step label is humanized to "step" when null, prefixed with the play
    // glyph in the new divider chip.
    expect(screen.getByText(/step/)).toBeInTheDocument();
  });

  it("omits cost when null or zero", () => {
    const { rerender } = render(
      <StepBoundary {...baseProps} costUsd={null} />
    );
    expect(screen.queryByText(/\$/)).toBeNull();
    rerender(<StepBoundary {...baseProps} costUsd={0} />);
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("does not render a prompt toggle inline — prompts surface as user bubbles instead", () => {
    render(<StepBoundary {...baseProps} />);
    expect(screen.queryByTestId("step-boundary-prompt-toggle")).toBeNull();
    expect(screen.queryByTestId("step-boundary-prompt")).toBeNull();
  });

  it("indents 16px per depth level", () => {
    render(<StepBoundary {...baseProps} depth={2} />);
    const el = screen.getByTestId("unified-chat-step-boundary");
    expect(el.style.marginLeft).toBe("32px");
    expect(el.getAttribute("data-depth")).toBe("2");
  });

  it("uses default neutral line border when thresholdKind is null", () => {
    render(<StepBoundary {...baseProps} />);
    const el = screen.getByTestId("unified-chat-step-boundary");
    expect(el.getAttribute("data-threshold-kind")).toBe("");
    expect(screen.queryByTestId("step-boundary-threshold-callout")).toBeNull();
  });

  it("shows a REJECTION callout for thresholdKind='rejection' with error tint", () => {
    render(<StepBoundary {...baseProps} thresholdKind="rejection" />);
    const el = screen.getByTestId("unified-chat-step-boundary");
    expect(el.getAttribute("data-threshold-kind")).toBe("rejection");
    const callout = screen.getByTestId("step-boundary-threshold-callout");
    expect(callout.getAttribute("data-kind")).toBe("rejection");
    expect(callout.className).toMatch(/text-err/);
    expect(callout.textContent).toBe("rejection");
  });

  it("shows an APPROVAL callout for thresholdKind='approval' with success tint", () => {
    render(<StepBoundary {...baseProps} thresholdKind="approval" />);
    const callout = screen.getByTestId("step-boundary-threshold-callout");
    expect(callout.getAttribute("data-kind")).toBe("approval");
    expect(callout.className).toMatch(/text-ok/);
  });

  it("humanizes underscores in the threshold callout label", () => {
    render(<StepBoundary {...baseProps} thresholdKind="model_fallback" />);
    const callout = screen.getByTestId("step-boundary-threshold-callout");
    expect(callout.textContent).toBe("model fallback");
  });
});
