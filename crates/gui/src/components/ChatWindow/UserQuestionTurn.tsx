import { useMemo, useState } from "react";
import { commands } from "../../bindings";
import type { JsonValue } from "../../bindings";
import type { ChatMessage } from "../../stores/chatStore";

type UserQuestionMessage = Extract<
  ChatMessage,
  { kind: "user_question" }
>;

export function UserQuestionTurn({
  message,
  sessionAvailable,
  onResolved,
  onUnavailable = () => {},
}: {
  message: UserQuestionMessage;
  sessionAvailable: boolean;
  onResolved: (requestId: string) => void;
  onUnavailable?: (requestId: string) => void;
}) {
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [freeText, setFreeText] = useState<Record<number, string>>({});
  const [submission, setSubmission] = useState<
    "idle" | "submitting" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorIsRetryable, setErrorIsRetryable] = useState(false);

  const answers = useMemo(
    () =>
      Object.fromEntries(
        message.questions.map((question, index) => {
          const custom = freeText[index]?.trim() ?? "";
          const selected = question.options
            .map((option) => option.label)
            .filter((label) => selections[index]?.includes(label));
          const answer = question.multi_select
            ? [...selected, ...(custom ? [custom] : [])].join(", ")
            : custom || selected[0] || "";
          return [question.question, answer];
        })
      ),
    [freeText, message.questions, selections]
  );

  const isPending = message.status === "pending";
  const isActionable = isPending && sessionAvailable;
  const canSubmit =
    isActionable &&
    !message.inputError &&
    submission !== "submitting" &&
    message.questions.length > 0 &&
    Object.values(answers).every((answer) => answer.length > 0);

  const resolve = async (
    input: Parameters<typeof commands.resolvePermissionRequest>[0],
    allowed: boolean
  ) => {
    if (!allowed || submission === "submitting") return;
    setSubmission("submitting");
    setError(null);
    setErrorIsRetryable(false);
    try {
      const result = await commands.resolvePermissionRequest(input);
      if (result.status === "error") {
        const unavailable =
          result.error.kind === "unavailable" ||
          result.error.kind === "not_found";
        setSubmission("error");
        setError(result.error.message);
        setErrorIsRetryable(!unavailable);
        if (unavailable) onUnavailable(message.requestId);
        return;
      }
      onResolved(message.requestId);
      setSubmission("idle");
    } catch (cause) {
      setSubmission("error");
      setError(
        cause instanceof Error ? cause.message : "Failed to resolve question"
      );
      setErrorIsRetryable(true);
    }
  };

  const submit = () =>
    resolve(
      {
        request_id: message.requestId,
        behavior: "allow",
        message: null,
        updated_input: {
          questions: message.originalQuestions,
          answers,
        } as JsonValue,
      },
      canSubmit
    );

  const rejectMalformed = () =>
    resolve(
      {
        request_id: message.requestId,
        behavior: "deny",
        message: message.inputError ?? "Invalid AskUserQuestion input",
        updated_input: null,
      },
      isActionable
    );

  const updateSelection = (
    questionIndex: number,
    label: string,
    multiSelect: boolean
  ) => {
    if (!multiSelect) {
      setFreeText((current) => ({ ...current, [questionIndex]: "" }));
    }
    setSelections((current) => {
      if (!multiSelect) return { ...current, [questionIndex]: [label] };
      const selected = current[questionIndex] ?? [];
      return {
        ...current,
        [questionIndex]: selected.includes(label)
          ? selected.filter((item) => item !== label)
          : [...selected, label],
      };
    });
  };

  const updateFreeText = (
    questionIndex: number,
    value: string,
    multiSelect: boolean
  ) => {
    setFreeText((current) => ({ ...current, [questionIndex]: value }));
    if (!multiSelect && value.length > 0) {
      setSelections((current) => ({ ...current, [questionIndex]: [] }));
    }
  };

  return (
    <section className="rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-bg-2)] p-4">
      <p className="mb-3 font-mono text-eyebrow uppercase tracking-wider text-[var(--color-accent)]">
        Claude needs your input
      </p>

      {message.inputError ? (
        <div className="space-y-3">
          <p className="text-sm text-[var(--color-err)]">
            This question could not be displayed: {message.inputError}
          </p>
          <button
            type="button"
            disabled={!isActionable || submission === "submitting"}
            onClick={() => void rejectMalformed()}
            className="rounded border border-[var(--color-err)]/40 px-3 py-1.5 text-xs font-medium text-[var(--color-err)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submission === "submitting"
              ? "Returning error..."
              : "Return error to Claude"}
          </button>
        </div>
      ) : (
        <div className="space-y-5">
          {message.questions.map((question, questionIndex) => (
            <fieldset
              key={`${question.question}-${questionIndex}`}
              disabled={!isActionable || submission === "submitting"}
              className="space-y-3"
            >
              <legend className="w-full">
                <span className="block font-mono text-xs uppercase tracking-wide text-[var(--color-fg-mute)]">
                  {question.header}
                </span>
                <span className="mt-1 block text-sm font-medium text-[var(--color-fg)]">
                  {question.question}
                </span>
              </legend>
              <div className="space-y-2">
                {question.options.map((option) => {
                  const checked =
                    selections[questionIndex]?.includes(option.label) ?? false;
                  return (
                    <label
                      key={option.label}
                      className="flex cursor-pointer gap-2 rounded border border-[var(--color-line)] p-2 has-[:checked]:border-[var(--color-accent)] has-[:checked]:bg-[var(--color-accent)]/5 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--color-accent)]"
                    >
                      <input
                        type={question.multi_select ? "checkbox" : "radio"}
                        className="sr-only"
                        name={`${message.requestId}-${questionIndex}`}
                        checked={checked}
                        onChange={() =>
                          updateSelection(
                            questionIndex,
                            option.label,
                            question.multi_select
                          )
                        }
                      />
                      <span>
                        <span className="block text-sm text-[var(--color-fg)]">
                          {option.label}
                        </span>
                        <span className="block text-xs text-[var(--color-fg-soft)]">
                          {option.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <label className="block text-xs text-[var(--color-fg-soft)]">
                Other answer (optional)
                <input
                  type="text"
                  value={freeText[questionIndex] ?? ""}
                  onChange={(event) =>
                    updateFreeText(
                      questionIndex,
                      event.target.value,
                      question.multi_select
                    )
                  }
                  className="mt-1 w-full rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
                />
              </label>
            </fieldset>
          ))}
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className="rounded border border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10 px-3 py-1.5 text-xs font-medium text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submission === "submitting" ? "Submitting..." : "Submit answers"}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-xs text-[var(--color-err)]">
          {error}
          {errorIsRetryable ? " You can retry." : ""}
        </p>
      )}
      {message.status === "resolved" && (
        <p className="mt-3 text-xs text-[var(--color-ok)]">Answered</p>
      )}
      {message.status === "unavailable" && (
        <p className="mt-3 text-xs text-[var(--color-fg-mute)]">
          This Claude session is no longer available.
        </p>
      )}
    </section>
  );
}
