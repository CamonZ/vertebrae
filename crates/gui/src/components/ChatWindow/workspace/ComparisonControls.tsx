import type { RefObject } from "react";
import type { ComparisonEndpoint } from "../../../bindings";
import { ComparisonSelect } from "./ComparisonSelect";
import type { ComparisonChoices } from "./useComparisonChoices";

export type DiffStyle = "unified" | "split";

const shortRef = (name: string) => name.replace(/^refs\/(heads|remotes)\//, "");

/**
 * The Changes toolbar: base and target selects, the diff layout and
 * refresh. Each select only reports a known endpoint.
 */
export function ComparisonControls({
  comparison,
  base,
  target,
  baseBranch,
  baseButton,
  targetButton,
  onBaseChange,
  onTargetChange,
  diffStyle,
  onDiffStyleChange,
  refreshDisabled,
  onRefresh,
}: {
  comparison: ComparisonChoices;
  base: ComparisonEndpoint | null;
  target: ComparisonEndpoint;
  /** The default base's branch name, once a load has reported it. */
  baseBranch: string | null;
  baseButton: RefObject<HTMLButtonElement | null>;
  targetButton: RefObject<HTMLButtonElement | null>;
  /** null: the default branch. */
  onBaseChange(endpoint: ComparisonEndpoint | null): void;
  onTargetChange(endpoint: ComparisonEndpoint): void;
  diffStyle: DiffStyle;
  onDiffStyleChange(style: DiffStyle): void;
  refreshDisabled: boolean;
  onRefresh(): void;
}) {
  const { choices, selectedKey, endpointFor } = comparison;
  const choiceOptions = choices.map((choice) => ({
    value: JSON.stringify(choice.endpoint),
    label: shortRef(choice.label),
  }));
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="changes-comparison-controls">
        <label>
          Base
          <ComparisonSelect
            label="Comparison base"
            buttonRef={baseButton}
            value={base ? selectedKey(base) : "auto"}
            onChange={(value) => {
              const endpoint = value === "auto" ? null : endpointFor(value);
              if (endpoint !== undefined) onBaseChange(endpoint);
            }}
            options={[
              {
                value: "auto",
                label: baseBranch
                  ? `${shortRef(baseBranch)} (default)`
                  : "Default branch",
              },
              { value: "head", label: "HEAD (current commit)" },
              ...choiceOptions,
            ]}
          />
        </label>
        <label>
          Compare
          <ComparisonSelect
            label="Comparison target"
            buttonRef={targetButton}
            value={selectedKey(target)}
            onChange={(value) => {
              const endpoint = endpointFor(value);
              if (endpoint) onTargetChange(endpoint);
            }}
            options={[
              { value: "working", label: "Working tree (current changes)" },
              { value: "head", label: "HEAD (current commit)" },
              ...choiceOptions,
            ]}
          />
        </label>
      </div>
      <div role="group" aria-label="Diff layout" className="document-views">
        {(["unified", "split"] as const).map((style) => (
          <button
            key={style}
            type="button"
            aria-pressed={diffStyle === style}
            onClick={() => onDiffStyleChange(style)}
          >
            {style === "unified" ? "Unified" : "Split"}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="changes-refresh"
        aria-label="Refresh changes"
        title="Refresh changes"
        disabled={refreshDisabled}
        onClick={onRefresh}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17" />
        </svg>
      </button>
    </div>
  );
}
