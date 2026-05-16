import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StepExecution, TaskRun } from "../../bindings";
import { HumanInputGate } from "./HumanInputGate";
import type { HumanInputGateContext } from "../../utils/humanInputGate";

const RUN: TaskRun = {
  id: "run-abc-123",
  task_id: "task-1",
  project_id: "project-1",
  user_id: null,
  status: "waiting",
  started_at: "2026-05-08T10:00:00Z",
  ended_at: null,
  stop_requested_at: null,
  latest_step_execution_id: "exec-xyz-456",
  outcome_kind: null,
  outcome_context: null,
  parent_task_run_id: null,
  root_task_run_id: null,
  triggered_by_step_execution_id: null,
  inserted_at: null,
  updated_at: null,
};

const EXEC: StepExecution = {
  id: "exec-xyz-456",
  task_id: "task-1",
  task_run_id: "run-abc-123",
  workflow_id: "wf-1",
  step_name: "approval",
  started_at: "2026-05-08T10:00:00Z",
  completed_at: null,
  status: "in_progress",
  prompt: "**Approve** the change?",
  output: null,
  context: null,
  transition_result: null,
  model: null,
  model_provider: null,
  input_tokens: null,
  output_tokens: null,
  cost: null,
  duration_ms: null,
  handoff: null,
  session_id: null,
};

function makeContext(
  overrides: Partial<HumanInputGateContext> = {}
): HumanInputGateContext {
  return {
    run: "run" in overrides ? (overrides.run as TaskRun) : RUN,
    execution:
      "execution" in overrides
        ? (overrides.execution as StepExecution | null)
        : EXEC,
    stepName:
      "stepName" in overrides
        ? (overrides.stepName as string | null)
        : (EXEC.step_name ?? null),
    prompt:
      "prompt" in overrides
        ? (overrides.prompt as string | null)
        : (EXEC.prompt ?? null),
    outputSchema:
      "outputSchema" in overrides ? overrides.outputSchema : null,
  };
}

describe("HumanInputGate", () => {
  it("renders run id, execution id, and step name", () => {
    render(<HumanInputGate context={makeContext()} />);
    const gate = screen.getByTestId("human-input-gate");
    expect(gate).toHaveAttribute("data-run-id", "run-abc-123");
    expect(gate).toHaveAttribute("data-execution-id", "exec-xyz-456");
    expect(screen.getByTestId("human-input-gate-run-id")).toHaveTextContent(
      "run-abc-123"
    );
    expect(screen.getByTestId("human-input-gate-execution-id")).toHaveTextContent(
      "exec-xyz-456"
    );
    expect(screen.getByTestId("human-input-gate-step")).toHaveTextContent(
      "approval"
    );
  });

  it("does not render Stop when stoppable is false", () => {
    render(<HumanInputGate context={makeContext()} stoppable={false} />);
    expect(
      screen.queryByTestId("human-input-gate-stop")
    ).not.toBeInTheDocument();
  });

  it("does not render Stop when stoppable is true but no onStop handler", () => {
    render(<HumanInputGate context={makeContext()} stoppable={true} />);
    expect(
      screen.queryByTestId("human-input-gate-stop")
    ).not.toBeInTheDocument();
  });

  it("renders Stop only when stoppable is true and invokes onStop on click", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(
      <HumanInputGate
        context={makeContext()}
        stoppable={true}
        onStop={onStop}
      />
    );
    const stopBtn = screen.getByTestId("human-input-gate-stop");
    expect(stopBtn).toBeEnabled();
    await user.click(stopBtn);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("disables Stop while a stop request is in flight", () => {
    render(
      <HumanInputGate
        context={makeContext()}
        stoppable={true}
        isStopping={true}
        onStop={() => {}}
      />
    );
    const stopBtn = screen.getByTestId("human-input-gate-stop");
    expect(stopBtn).toBeDisabled();
    expect(stopBtn).toHaveTextContent("Stopping...");
  });

  it("does not expose a submit / approve / bypass action", () => {
    render(<HumanInputGate context={makeContext()} stoppable onStop={() => {}} />);
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /bypass/i })).toBeNull();
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /copy full .* ID/i })
    ).toHaveLength(2);
  });

  it("renders prompt content when expanded", async () => {
    const user = userEvent.setup();
    render(<HumanInputGate context={makeContext()} />);
    expect(
      screen.queryByTestId("human-input-gate-prompt")
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId("human-input-gate-prompt-toggle"));
    expect(screen.getByTestId("human-input-gate-prompt")).toBeInTheDocument();
  });

  it("renders the output_schema as JSON when expanded", async () => {
    const user = userEvent.setup();
    const schema = {
      type: "object",
      properties: { decision: { type: "string" } },
    };
    render(
      <HumanInputGate
        context={makeContext({ outputSchema: schema })}
      />
    );
    expect(
      screen.queryByTestId("human-input-gate-schema")
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId("human-input-gate-schema-toggle"));
    const pre = screen.getByTestId("human-input-gate-schema");
    expect(pre.textContent).toContain('"decision"');
    expect(pre.textContent).toContain('"object"');
  });

  it("falls back to em-dash for execution id when execution is null", () => {
    render(
      <HumanInputGate
        context={makeContext({ execution: null, stepName: null })}
      />
    );
    expect(
      screen.getByTestId("human-input-gate-execution-id")
    ).toHaveTextContent("—");
  });
});
