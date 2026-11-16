/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — structured_inference config editor.
   ────────────────────────────────────────────────────────────────── */
import { PanelCode } from "../../shared/PanelCode";
import type { StructuredInferenceInput } from "../../../utils/stepConfig";

export function StructuredInferenceQuestions({
  value,
  onChange,
  error,
}: {
  error?: string | null;
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
        <PanelCode
          label="State"
          language={/[{][{%]/.test(value.state) ? "liquid" : "json"}
          source={value.state}
          onChange={set("state")}
          error={error?.toLowerCase().includes("state") ? error : undefined}
        />
      </label>
      <label>
        Questions
        <PanelCode
          label="Questions"
          language="json"
          source={value.questions}
          onChange={set("questions")}
          error={error?.toLowerCase().includes("questions") ? error : undefined}
        />
      </label>
    </>
  );
}
