import { useState, type FormEvent, type ReactNode } from "react";
import type { GateField, JsonValue } from "../../bindings";
import { Button } from "../atoms/Button";
import { Input } from "../atoms/Input";
import { Select } from "../atoms/Select";
import { errorMessage } from "../../query";
import {
  fieldControl,
  initialFormInput,
  parseFormInput,
  type GateDraftValues,
  type GateFormInput,
} from "../../utils/gateDraft";

interface GateAnswerFormProps {
  /** Fields to answer, in schema order. */
  fields: readonly GateField[];
  /** Answers already recorded, shown as the starting values. */
  values: GateDraftValues;
  submitLabel: string;
  /** Enable submit only once every required field shown has an answer. */
  requireRequired?: boolean;
  /** Receives the answers to record; a cleared earlier answer is null. */
  onSubmit: (answers: GateDraftValues) => Promise<void>;
  /** Notify the owner when local edits need protection from background updates. */
  onEdit?: () => void;
  testId?: string;
  children?: ReactNode;
}

/**
 * A form generated from a gate's output schema: enums become choices, enum
 * arrays multi-select, booleans yes/no, numbers numeric inputs and strings
 * text with their format hint.
 */
export function GateAnswerForm({
  fields,
  values,
  submitLabel,
  requireRequired = false,
  onSubmit,
  onEdit,
  testId = "gate-answer-form",
  children,
}: GateAnswerFormProps): ReactNode {
  // Only edited fields are local. Untouched controls follow the durable
  // draft without overwriting answers the user is still typing.
  const [inputs, setInputs] = useState<Record<string, GateFormInput>>({});
  const inputFor = (field: GateField): GateFormInput =>
    Object.prototype.hasOwnProperty.call(inputs, field.name)
      ? inputs[field.name]
      : initialFormInput(field, values[field.name]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setInput = (name: string, input: GateFormInput) => {
    onEdit?.();
    setInputs((current) => ({ ...current, [name]: input }));
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const parsed = fields.map((field) => ({
    field,
    result: parseFormInput(field, inputFor(field)),
  }));
  const requiredAnswered = parsed.every(
    ({ field, result }) => !field.required || result.kind === "answered"
  );
  const anyAnswered = parsed.some(({ result }) => result.kind === "answered");
  const canSubmit =
    !submitting && (requireRequired ? requiredAnswered : anyAnswered);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const errors: Record<string, string> = {};
    const answers: Record<string, JsonValue> = {};
    for (const { field, result } of parsed) {
      if (result.kind === "error") errors[field.name] = result.message;
      else if (result.kind === "answered") answers[field.name] = result.value;
      else if (field.name in values) answers[field.name] = null;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit(answers);
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      data-testid={testId}
      className="space-y-3"
      onSubmit={(event) => void handleSubmit(event)}
    >
      {children}
      {fields.map((field) => (
        <GateFieldInput
          key={field.name}
          field={field}
          input={inputFor(field)}
          error={fieldErrors[field.name] ?? null}
          onChange={(input) => setInput(field.name, input)}
        />
      ))}
      {submitError && (
        <p
          role="alert"
          data-testid={`${testId}-error`}
          className="text-xs text-[var(--color-err)]"
        >
          {submitError}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        size="sm"
        loading={submitting}
        disabled={!canSubmit}
        data-testid={`${testId}-submit`}
      >
        {submitLabel}
      </Button>
    </form>
  );
}

interface GateFieldInputProps {
  field: GateField;
  input: GateFormInput;
  error: string | null;
  onChange: (input: GateFormInput) => void;
}

const TEXT_FORMAT_TYPES: Record<string, string> = {
  date: "date",
  email: "email",
};

function GateFieldInput({
  field,
  input,
  error,
  onChange,
}: GateFieldInputProps): ReactNode {
  const id = `gate-field-${field.name}`;
  const inputTestId = `gate-answer-input-${field.name}`;
  const control = fieldControl(field);
  const label = (
    <span className="block text-sm text-[var(--color-fg)]">
      <span className="font-mono">{field.name}</span>
      {field.required && (
        <span className="text-[var(--color-fg-mute)]"> (required)</span>
      )}
      {field.question && (
        <span className="mt-0.5 block text-xs text-[var(--color-fg-soft)]">
          {field.question}
        </span>
      )}
    </span>
  );

  let body: ReactNode;
  switch (control) {
    case "choice":
      body = (
        <Select
          id={id}
          data-testid={inputTestId}
          aria-label={field.name}
          value={typeof input === "string" ? input : ""}
          placeholder="Choose…"
          invalid={error !== null}
          onChange={(event) => onChange(event.target.value)}
          options={(field.choices ?? []).map((choice) => ({
            value: choice,
            label: choice,
          }))}
        />
      );
      break;
    case "multi": {
      const selected = Array.isArray(input) ? input : [];
      body = (
        <div
          role="group"
          aria-label={field.name}
          className="flex flex-wrap gap-3"
        >
          {(field.choices ?? []).map((choice) => (
            <label key={choice} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                data-testid={`${inputTestId}-${choice}`}
                checked={selected.includes(choice)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, choice]
                      : selected.filter((value) => value !== choice)
                  )
                }
              />
              {choice}
            </label>
          ))}
        </div>
      );
      break;
    }
    case "boolean":
      body = (
        <div role="radiogroup" aria-label={field.name} className="flex gap-2">
          {[true, false].map((choice) => (
            <Button
              key={String(choice)}
              size="sm"
              variant={input === choice ? "primary" : "secondary"}
              role="radio"
              aria-checked={input === choice}
              data-testid={`${inputTestId}-${choice ? "yes" : "no"}`}
              onClick={() => onChange(choice)}
            >
              {choice ? "Yes" : "No"}
            </Button>
          ))}
        </div>
      );
      break;
    case "number":
    case "integer":
      body = (
        <Input
          id={id}
          data-testid={inputTestId}
          type="number"
          step={control === "integer" ? 1 : "any"}
          value={typeof input === "string" ? input : ""}
          invalid={error !== null}
          onChange={(event) => onChange(event.target.value)}
        />
      );
      break;
    case "text":
      body = (
        <Input
          id={id}
          data-testid={inputTestId}
          type={(field.format && TEXT_FORMAT_TYPES[field.format]) || "text"}
          value={typeof input === "string" ? input : ""}
          placeholder={field.format ? `Format: ${field.format}` : undefined}
          invalid={error !== null}
          onChange={(event) => onChange(event.target.value)}
        />
      );
      break;
    default:
      body = (
        <p className="text-xs text-[var(--color-fg-mute)]">
          Answer this field in the chat.
        </p>
      );
  }

  return (
    <div data-testid="gate-answer-field" data-field={field.name}>
      {control === "multi" || control === "boolean" ? (
        <div className="space-y-1.5">
          {label}
          {body}
        </div>
      ) : (
        <label htmlFor={id} className="block space-y-1.5">
          {label}
          {body}
        </label>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-[var(--color-err)]">
          {error}
        </p>
      )}
    </div>
  );
}
