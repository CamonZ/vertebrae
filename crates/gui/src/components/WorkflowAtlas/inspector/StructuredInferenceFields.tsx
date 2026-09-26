/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — structured_inference config editor.
   ────────────────────────────────────────────────────────────────── */
import type { StructuredInferenceInput } from "../../../utils/stepConfig";

export function StructuredInferenceFields({
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
        Fields
        <textarea
          value={value.fields}
          onChange={(e) => set("fields")(e.target.value)}
          placeholder="Output JSON Schema"
        />
      </label>
    </>
  );
}
