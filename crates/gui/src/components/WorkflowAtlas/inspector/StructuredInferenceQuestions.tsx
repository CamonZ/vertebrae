/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — structured_inference config editor.
   ────────────────────────────────────────────────────────────────── */
import type { StructuredInferenceInput } from "../../../utils/stepConfig";

export function StructuredInferenceQuestions({
  value,
  onChange,
}: {
  value: StructuredInferenceInput;
  onChange: (value: StructuredInferenceInput) => void;
}) {
  const set = (key: keyof StructuredInferenceInput) => (text: string) =>
    onChange({ ...value, [key]: text });
  return (
    <>
      <label>
        Provider
        <input
          value={value.provider}
          onChange={(e) => set("provider")(e.target.value)}
        />
      </label>
      <label>
        Model
        <input
          value={value.model}
          onChange={(e) => set("model")(e.target.value)}
        />
      </label>
      <label>
        State{" "}
        <span className="wfd-help">JSON or {"{{ dotted.path }}"} template</span>
        <textarea
          value={value.state}
          onChange={(e) => set("state")(e.target.value)}
        />
      </label>
      <label>
        Questions
        <textarea
          value={value.questions}
          onChange={(e) => set("questions")(e.target.value)}
          placeholder="System One questions JSON"
        />
      </label>
    </>
  );
}
