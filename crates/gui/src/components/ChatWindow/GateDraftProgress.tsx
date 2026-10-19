import type { ReactNode } from "react";
import type { GateDraft, GateField } from "../../bindings";
import {
  draftValues,
  fieldOfPath,
  formatDraftValue,
} from "../../utils/gateDraft";

interface GateDraftProgressProps {
  fields: readonly GateField[];
  draft: GateDraft;
  attempt: number;
}

type FieldState = "answered" | "invalid" | "missing" | "optional";

/**
 * Each field of a draftable gate with its question and where it stands, as
 * the durable draft reports it. Shown with the gate chat's status bar.
 */
export function GateDraftProgress({
  fields,
  draft,
  attempt,
}: GateDraftProgressProps): ReactNode {
  const values = draftValues(draft);
  const missing = new Set(draft.missing);
  const invalid = new Map<string, string[]>();
  for (const violation of draft.invalid) {
    const field = fieldOfPath(violation.path);
    invalid.set(field, [...(invalid.get(field) ?? []), violation.message]);
  }
  const stateOf = (field: GateField): FieldState => {
    if (invalid.has(field.name)) return "invalid";
    if (field.name in values) return "answered";
    return missing.has(field.name) ? "missing" : "optional";
  };

  return (
    <section
      data-testid="gate-draft-progress"
      data-complete={draft.complete ? "1" : "0"}
      aria-label="Gate answers"
      className="max-h-56 overflow-y-auto border-b border-[var(--color-line)] px-3 py-2 text-xs"
    >
      <div className="mb-1.5 flex items-center justify-between font-mono uppercase tracking-wider text-[var(--color-fg-mute)]">
        <span>{draft.complete ? "Answers complete" : "Answers so far"}</span>
        <span data-testid="gate-draft-attempt">Attempt {attempt}</span>
      </div>
      <ul className="space-y-1">
        {fields.map((field) => {
          const state = stateOf(field);
          return (
            <li
              key={field.name}
              data-testid="gate-draft-field"
              data-field={field.name}
              data-state={state}
              className="flex flex-wrap items-baseline gap-x-2"
            >
              <span
                aria-hidden="true"
                className={
                  state === "answered"
                    ? "text-[var(--color-ok)]"
                    : state === "invalid"
                      ? "text-[var(--color-err)]"
                      : "text-[var(--color-fg-faint)]"
                }
              >
                {state === "answered" ? "●" : state === "invalid" ? "!" : "○"}
              </span>
              <span className="font-mono text-[var(--color-fg)]">
                {field.name}
              </span>
              {field.question && (
                <span className="text-[var(--color-fg-soft)]">
                  {field.question}
                </span>
              )}
              <span
                data-testid="gate-draft-value"
                className={
                  field.name in values
                    ? "text-[var(--color-fg)]"
                    : "italic text-[var(--color-fg-mute)]"
                }
              >
                {field.name in values
                  ? formatDraftValue(values[field.name])
                  : state === "optional"
                    ? "optional"
                    : "not yet answered"}
              </span>
              {invalid.get(field.name)?.map((message) => (
                <span
                  key={message}
                  data-testid="gate-draft-invalid"
                  className="basis-full pl-4 text-[var(--color-err)]"
                >
                  {message}
                </span>
              ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
