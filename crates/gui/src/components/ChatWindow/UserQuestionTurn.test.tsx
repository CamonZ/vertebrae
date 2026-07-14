import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "../../bindings";
import type { ChatMessage } from "../../stores/chatStore";
import { UserQuestionTurn } from "./UserQuestionTurn";

vi.mock("../../bindings", () => ({
  commands: { resolvePermissionRequest: vi.fn() },
}));

const resolvePermissionRequest = vi.mocked(commands.resolvePermissionRequest);

function message(
  overrides: Partial<Extract<ChatMessage, { kind: "user_question" }>> = {}
): Extract<ChatMessage, { kind: "user_question" }> {
  const questions = [
    {
      question: "Which layers?",
      header: "Scope",
      options: [
        { label: "Backend", description: "Rust changes" },
        { label: "Frontend", description: "React changes" },
      ],
      multi_select: true,
    },
    {
      question: "Deployment target?",
      header: "Deploy",
      options: [
        { label: "Staging", description: "Test environment" },
        { label: "Production", description: "Live environment" },
      ],
      multi_select: false,
    },
  ];
  return {
    kind: "user_question",
    requestId: "req-1",
    toolUseId: "tool-1",
    questions,
    originalQuestions: questions,
    status: "pending",
    timestamp: "2026-07-14T00:00:00Z",
    ...overrides,
  };
}

describe("UserQuestionTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolvePermissionRequest.mockResolvedValue({ status: "ok", data: null });
  });

  it("renders headers, question text, labels, and descriptions", () => {
    render(
      <UserQuestionTurn
        message={message()}
        sessionAvailable
        onResolved={vi.fn()}
      />
    );
    for (const text of [
      "Scope",
      "Which layers?",
      "Backend",
      "Rust changes",
      "Deploy",
      "Deployment target?",
      "Production",
      "Live environment",
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    checkboxes.forEach((checkbox) => expect(checkbox).toHaveClass("sr-only"));
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    radios.forEach((radio) => expect(radio).toHaveClass("sr-only"));
  });

  it("serializes multi-select in display order, single-select, and free text", async () => {
    const onResolved = vi.fn();
    render(
      <UserQuestionTurn
        message={message()}
        sessionAvailable
        onResolved={onResolved}
      />
    );
    fireEvent.click(screen.getByLabelText(/Frontend/));
    fireEvent.click(screen.getByLabelText(/Backend/));
    const freeInputs = screen.getAllByLabelText("Other answer (optional)");
    fireEvent.change(freeInputs[0], { target: { value: "Docs" } });
    fireEvent.change(freeInputs[1], { target: { value: "Canary" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    await waitFor(() =>
      expect(resolvePermissionRequest).toHaveBeenCalledWith({
        request_id: "req-1",
        behavior: "allow",
        message: null,
        updated_input: {
          questions: message().originalQuestions,
          answers: {
            "Which layers?": "Backend, Frontend, Docs",
            "Deployment target?": "Canary",
          },
        },
      })
    );
    expect(onResolved).toHaveBeenCalledWith("req-1");
  });

  it("keeps a single-select option and free-text answer mutually exclusive", () => {
    render(
      <UserQuestionTurn
        message={message()}
        sessionAvailable
        onResolved={vi.fn()}
      />
    );
    const otherAnswers = screen.getAllByLabelText("Other answer (optional)");
    const staging = screen.getByLabelText(/Staging/);
    const production = screen.getByLabelText(/Production/);

    fireEvent.click(staging);
    expect(staging).toBeChecked();

    fireEvent.change(otherAnswers[1], { target: { value: "Canary" } });
    expect(staging).not.toBeChecked();
    expect(otherAnswers[1]).toHaveValue("Canary");

    fireEvent.click(production);
    expect(production).toBeChecked();
    expect(otherAnswers[1]).toHaveValue("");
  });

  it("prevents duplicate submission while the first request is in flight", async () => {
    resolvePermissionRequest.mockReturnValue(new Promise(() => {}));
    render(
      <UserQuestionTurn
        message={message()}
        sessionAvailable
        onResolved={vi.fn()}
      />
    );
    fireEvent.click(screen.getByLabelText(/Backend/));
    fireEvent.click(screen.getByLabelText(/Staging/));
    const submit = screen.getByRole("button", { name: "Submit answers" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText("Submitting...")).toBeDisabled());
    expect(resolvePermissionRequest).toHaveBeenCalledTimes(1);
  });

  it("shows a recoverable error and allows retry", async () => {
    resolvePermissionRequest
      .mockResolvedValueOnce({
        status: "error",
        error: { kind: "internal", message: "Bridge disconnected" },
      })
      .mockResolvedValueOnce({ status: "ok", data: null });
    render(
      <UserQuestionTurn
        message={message()}
        sessionAvailable
        onResolved={vi.fn()}
      />
    );
    fireEvent.click(screen.getByLabelText(/Backend/));
    fireEvent.click(screen.getByLabelText(/Staging/));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Bridge disconnected You can retry."
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    await waitFor(() => expect(resolvePermissionRequest).toHaveBeenCalledTimes(2));
  });

  it("marks a disconnected permission request unavailable instead of offering retry", async () => {
    const onUnavailable = vi.fn();
    resolvePermissionRequest.mockResolvedValue({
      status: "error",
      error: {
        kind: "unavailable",
        message: "Permission request connection is no longer available",
      },
    });
    render(
      <UserQuestionTurn
        message={message()}
        sessionAvailable
        onResolved={vi.fn()}
        onUnavailable={onUnavailable}
      />
    );
    fireEvent.click(screen.getByLabelText(/Backend/));
    fireEvent.click(screen.getByLabelText(/Staging/));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Permission request connection is no longer available"
    );
    expect(alert).not.toHaveTextContent("You can retry");
    expect(onUnavailable).toHaveBeenCalledWith("req-1");
  });

  it("shows malformed input without exposing editable raw JSON", async () => {
    render(
      <UserQuestionTurn
        message={message({
          questions: [],
          inputError: "questions must not be empty",
        })}
        sessionAvailable
        onResolved={vi.fn()}
      />
    );
    expect(
      screen.getByText(/questions must not be empty/)
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Return error to Claude" })
    );
    await waitFor(() =>
      expect(resolvePermissionRequest).toHaveBeenCalledWith({
        request_id: "req-1",
        behavior: "deny",
        message: "questions must not be empty",
        updated_input: null,
      })
    );
  });

  it("makes unresolved controls non-actionable when the backend is unavailable", () => {
    render(
      <UserQuestionTurn
        message={message({ status: "unavailable" })}
        sessionAvailable={false}
        onResolved={vi.fn()}
      />
    );
    expect(
      screen.getByText("This Claude session is no longer available.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit answers" })).toBeDisabled();
  });
});
