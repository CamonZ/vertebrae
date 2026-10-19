import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StepExecution, TaskRun } from "../../bindings";
import { HumanInputGate } from "./HumanInputGate";
import { queryClient } from "../../query";
import type { HumanInputGateContext } from "../../utils/humanInputGate";

const resolveGateInChat = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/useGateChat", () => ({
  useResolveGateInChat: () => resolveGateInChat,
}));

const draftCommands = vi.hoisted(() => ({
  getHumanInputDraft: vi.fn(),
  setHumanInputDraft: vi.fn(),
  submitHumanInputDraft: vi.fn(),
}));
vi.mock("../../bindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../bindings")>();
  return { ...actual, commands: { ...actual.commands, ...draftCommands } };
});

const RUN: TaskRun = {
  id: "run-abc-123",
  task_id: "task-1",
  project_id: "project-1",
  user_id: null,
  status: "waiting",
  max_concurrency: null,
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
  config: null,
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
    role: "role" in overrides ? (overrides.role as string | null) : null,
    question:
      "question" in overrides
        ? (overrides.question as string | null)
        : "**Approve** the change?",
    outputSchema: "outputSchema" in overrides ? overrides.outputSchema : null,
    fields: overrides.fields ?? [],
    artifact:
      "artifact" in overrides ? (overrides.artifact as string | null) : null,
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
    expect(
      screen.getByTestId("human-input-gate-execution-id")
    ).toHaveTextContent("exec-xyz-456");
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
    render(
      <HumanInputGate context={makeContext()} stoppable onStop={() => {}} />
    );
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /bypass/i })).toBeNull();
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /copy full .* ID/i })
    ).toHaveLength(2);
  });

  it("renders question content when expanded", async () => {
    const user = userEvent.setup();
    render(<HumanInputGate context={makeContext()} />);
    expect(
      screen.queryByTestId("human-input-gate-question")
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId("human-input-gate-question-toggle"));
    expect(screen.getByTestId("human-input-gate-question")).toBeInTheDocument();
  });

  it("renders the role and the schema field list when expanded", async () => {
    const user = userEvent.setup();
    render(
      <HumanInputGate
        context={makeContext({
          role: "You are a release manager.",
          fields: [
            {
              name: "approved",
              required: true,
              type: "boolean",
              question: "Should v2 ship?",
              value_type: "boolean",
              choices: null,
              multiple: false,
              format: null,
            },
            {
              name: "notes",
              required: false,
              type: "string",
              question: null,
              value_type: "string",
              choices: null,
              multiple: false,
              format: null,
            },
          ],
        })}
      />
    );
    await user.click(screen.getByTestId("human-input-gate-role-toggle"));
    expect(screen.getByTestId("human-input-gate-role")).toHaveTextContent(
      "You are a release manager."
    );
    await user.click(screen.getByTestId("human-input-gate-fields-toggle"));
    const fields = screen.getAllByTestId("human-input-gate-field");
    expect(fields).toHaveLength(2);
    expect(fields[0]).toHaveTextContent(
      "approved (required, boolean): Should v2 ship?"
    );
    expect(fields[1]).toHaveTextContent("notes (optional, string)");
  });

  it("renders the output_schema as JSON when expanded", async () => {
    const user = userEvent.setup();
    const schema = {
      type: "object",
      properties: { decision: { type: "string" } },
    };
    render(<HumanInputGate context={makeContext({ outputSchema: schema })} />);
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

  it("opens the gate chat from Resolve when the gate has an artifact", async () => {
    const user = userEvent.setup();
    const context = makeContext({ artifact: "approval" });
    render(<HumanInputGate context={context} />);

    const resolve = screen.getByTestId("human-input-gate-resolve");
    expect(resolve).toBeEnabled();
    await user.click(resolve);

    expect(resolveGateInChat).toHaveBeenCalledWith(context);
  });

  describe("answering directly", () => {
    const fields = [
      {
        name: "approved",
        required: true,
        type: "boolean",
        question: "Ship it?",
        value_type: "boolean",
        choices: null,
        multiple: false,
        format: null,
      },
      {
        name: "reason",
        required: true,
        type: "string",
        question: "Why?",
        value_type: "string",
        choices: null,
        multiple: false,
        format: null,
      },
    ];
    const draft = {
      execution_id: EXEC.id!,
      values: {},
      missing: ["approved", "reason"],
      invalid: [],
      complete: false,
    };

    beforeEach(() => {
      queryClient.clear();
      vi.clearAllMocks();
      draftCommands.getHumanInputDraft.mockResolvedValue({
        status: "ok",
        data: null,
      });
      draftCommands.setHumanInputDraft.mockResolvedValue({
        status: "ok",
        data: { ...draft, complete: true, missing: [] },
      });
      draftCommands.submitHumanInputDraft.mockResolvedValue({
        status: "ok",
        data: { ...draft, complete: true, missing: [] },
      });
    });

    it("is not offered when the gate is not draftable", async () => {
      render(
        <HumanInputGate
          context={makeContext({ artifact: "approval", fields })}
        />
      );

      await waitFor(() =>
        expect(draftCommands.getHumanInputDraft).toHaveBeenCalledWith(EXEC.id)
      );
      expect(
        screen.queryByTestId("human-input-gate-answer-directly")
      ).not.toBeInTheDocument();
    });

    it("keeps dirty edits while untouched answers follow realtime draft updates", async () => {
      const user = userEvent.setup();
      draftCommands.getHumanInputDraft.mockResolvedValue({
        status: "ok",
        data: draft,
      });
      const context = makeContext({ artifact: "approval", fields });
      const { rerender } = render(<HumanInputGate context={context} />);
      await user.click(
        await screen.findByTestId("human-input-gate-answer-directly")
      );
      await user.type(screen.getByRole("textbox"), "Still typing");
      draftCommands.getHumanInputDraft.mockResolvedValue({
        status: "ok",
        data: {
          ...draft,
          values: { approved: true, reason: "Agent's answer" },
        },
      });
      rerender(
        <HumanInputGate
          context={{
            ...context,
            execution: { ...EXEC, draft_updated_at: "2026-10-20T12:00:00Z" },
          }}
        />
      );
      await waitFor(() =>
        expect(screen.getByRole("radio", { name: "Yes" })).toHaveAttribute(
          "aria-checked",
          "true"
        )
      );
      expect(screen.getByRole("textbox")).toHaveValue("Still typing");
    });

    it("submits a draftable gate through its draft once every required field is filled", async () => {
      const user = userEvent.setup();
      draftCommands.getHumanInputDraft.mockResolvedValue({
        status: "ok",
        data: draft,
      });
      render(
        <HumanInputGate
          context={makeContext({ artifact: "approval", fields })}
        />
      );

      await user.click(
        await screen.findByTestId("human-input-gate-answer-directly")
      );
      const submit = screen.getByTestId("human-input-gate-answer-form-submit");
      expect(submit).toBeDisabled();
      await user.click(screen.getByRole("radio", { name: "Yes" }));
      expect(submit).toBeDisabled();
      await user.type(screen.getByRole("textbox"), "Tested");
      expect(submit).toBeEnabled();
      await user.click(submit);

      await waitFor(() =>
        expect(draftCommands.submitHumanInputDraft).toHaveBeenCalledWith(
          EXEC.id
        )
      );
      expect(draftCommands.setHumanInputDraft).toHaveBeenCalledWith(EXEC.id, {
        approved: true,
        reason: "Tested",
      });
      expect(
        draftCommands.setHumanInputDraft.mock.invocationCallOrder[0]
      ).toBeLessThan(
        draftCommands.submitHumanInputDraft.mock.invocationCallOrder[0]
      );
      expect(
        screen.queryByTestId("human-input-gate-direct-answer")
      ).not.toBeInTheDocument();
    });

    it("keeps the form open and shows why a submission failed", async () => {
      const user = userEvent.setup();
      draftCommands.getHumanInputDraft.mockResolvedValue({
        status: "ok",
        data: {
          ...draft,
          values: { approved: false, reason: "No" },
          missing: [],
        },
      });
      draftCommands.submitHumanInputDraft.mockResolvedValue({
        status: "error",
        error: {
          message:
            "Human input rejected: draft is missing required fields: reason",
        },
      });
      render(
        <HumanInputGate
          context={makeContext({ artifact: "approval", fields })}
        />
      );

      await user.click(
        await screen.findByTestId("human-input-gate-answer-directly")
      );
      await user.click(
        screen.getByTestId("human-input-gate-answer-form-submit")
      );

      expect(
        await screen.findByTestId("human-input-gate-answer-form-error")
      ).toHaveTextContent("draft is missing required fields: reason");
      expect(
        screen.getByTestId("human-input-gate-direct-answer")
      ).toBeInTheDocument();
    });
  });

  it("disables Resolve when no artifact resolves the gate", () => {
    render(<HumanInputGate context={makeContext({ artifact: null })} />);

    const resolve = screen.getByTestId("human-input-gate-resolve");
    expect(resolve).toBeDisabled();
    expect(resolve).toHaveAttribute(
      "title",
      "Configure an artifact on this step to resolve it in a chat"
    );
  });
});
