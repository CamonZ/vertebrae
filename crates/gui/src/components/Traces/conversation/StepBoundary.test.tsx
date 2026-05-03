import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

  it("renders folded session facts (duration, turns, cost) in the right-side trio", () => {
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

  it("does not render a prompt toggle when prompt is null or empty", () => {
    const { rerender } = render(<StepBoundary {...baseProps} />);
    expect(screen.queryByTestId("step-boundary-prompt-toggle")).toBeNull();
    expect(screen.queryByTestId("step-boundary-prompt")).toBeNull();
    rerender(<StepBoundary {...baseProps} prompt={null} />);
    expect(screen.queryByTestId("step-boundary-prompt-toggle")).toBeNull();
    rerender(<StepBoundary {...baseProps} prompt="" />);
    expect(screen.queryByTestId("step-boundary-prompt-toggle")).toBeNull();
    rerender(<StepBoundary {...baseProps} prompt={"   \n  "} />);
    expect(screen.queryByTestId("step-boundary-prompt-toggle")).toBeNull();
  });

  it("renders a collapsed prompt toggle when prompt is set, expanding to show markdown content", () => {
    render(
      <StepBoundary
        {...baseProps}
        prompt={"# Prompt heading\n\nDo **the** thing."}
      />
    );
    const toggle = screen.getByTestId("step-boundary-prompt-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("step-boundary-prompt")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const promptEl = screen.getByTestId("step-boundary-prompt");
    // MarkdownContent should render a heading and bold for the markdown source.
    expect(promptEl.querySelector("h1")?.textContent).toBe("Prompt heading");
    expect(promptEl.querySelector("strong")?.textContent).toBe("the");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("step-boundary-prompt")).toBeNull();
  });

  it("indents 16px per depth level", () => {
    render(<StepBoundary {...baseProps} depth={2} />);
    const el = screen.getByTestId("unified-chat-step-boundary");
    expect(el.style.marginLeft).toBe("32px");
    expect(el.getAttribute("data-depth")).toBe("2");
  });
});
