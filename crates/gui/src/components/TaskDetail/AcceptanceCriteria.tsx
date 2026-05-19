import { useCallback, useMemo } from "react";
import type { Section, CodeRef } from "../../bindings";
import { commands } from "../../bindings";

interface AcceptanceCriteriaProps {
  criteria: Section[];
  taskId: string;
  onSectionsChanged?: () => void;
}

type CriterionStatus = "met" | "not_met" | "pending";

function deriveCriterionStatus(section: Section): CriterionStatus {
  if (section.done === true) return "met";
  if (section.done === false && section.done_at !== null) return "not_met";
  return "pending";
}

type ValidationType = "machine" | "human";

function deriveValidationType(section: Section): ValidationType {
  const refs = section.refs ?? [];
  return refs.length > 0 ? "machine" : "human";
}

function StatusIndicator({ status }: { status: CriterionStatus }) {
  switch (status) {
    case "met":
      return (
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-success/20 text-success">
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.5}
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>
      );
    case "not_met":
      return (
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-error/20 text-error">
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.5}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </div>
      );
    case "pending":
      return (
        <div className="h-5 w-5 rounded-full border border-border-strong" />
      );
  }
}

function ValidationBadge({ type }: { type: ValidationType }) {
  if (type === "machine") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 text-xs font-medium text-info">
        <svg
          className="h-2.5 w-2.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
          />
        </svg>
        machine
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
      <svg
        className="h-2.5 w-2.5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
        />
      </svg>
      human
    </span>
  );
}

function CriterionRefsList({ refs }: { refs: CodeRef[] }) {
  if (refs.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {refs.map((ref, i) => {
        const lineRange =
          ref.line_start !== null
            ? ref.line_end !== null && ref.line_end !== ref.line_start
              ? `L${ref.line_start}-${ref.line_end}`
              : `L${ref.line_start}`
            : null;
        return (
          <span
            key={`${ref.path}-${i}`}
            className="inline-flex items-center gap-1 rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-xs text-text-muted"
            title={ref.description ?? ref.path}
          >
            {ref.path.split("/").pop()}
            {lineRange && (
              <span className="text-primary">{lineRange}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function CriterionItem({
  section,
  onToggle,
}: {
  section: Section;
  onToggle: () => void;
}) {
  const status = deriveCriterionStatus(section);
  const validationType = deriveValidationType(section);

  return (
    <div
      className={`flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors ${
        status === "met"
          ? "bg-success/5"
          : status === "not_met"
            ? "bg-error/5"
            : "bg-bg-secondary"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="mt-0.5 flex-shrink-0 cursor-pointer"
        title={status === "met" ? "Mark as not met" : "Mark as met"}
        aria-label={
          status === "met"
            ? `Mark criterion as not met: ${section.content}`
            : `Mark criterion as met: ${section.content}`
        }
      >
        <StatusIndicator status={status} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p
            className={`text-sm leading-relaxed ${
              status === "met"
                ? "text-text-muted line-through"
                : "text-text-primary"
            }`}
          >
            {section.content}
          </p>
          <ValidationBadge type={validationType} />
        </div>
        <CriterionRefsList refs={section.refs ?? []} />
      </div>
    </div>
  );
}

export function AcceptanceCriteria({
  criteria,
  taskId,
  onSectionsChanged,
}: AcceptanceCriteriaProps) {
  const sortedCriteria = useMemo(
    () => [...criteria].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [criteria]
  );

  const metCount = useMemo(
    () => sortedCriteria.filter((c) => c.done === true).length,
    [sortedCriteria]
  );
  const totalCount = sortedCriteria.length;

  const handleToggle = useCallback(
    async (section: Section) => {
      try {
        const result = await commands.toggleChecklistItemDone(
          taskId,
          section.order ?? 0
        );
        if (result.status === "error") {
          console.error("Failed to toggle criterion:", result.error.message);
        } else {
          onSectionsChanged?.();
        }
      } catch (err) {
        console.error("Failed to toggle criterion:", err);
      }
    },
    [taskId, onSectionsChanged]
  );

  if (totalCount === 0) {
    return (
      <div className="px-4 py-3">
        <p className="text-xs text-text-muted italic">
          No acceptance criteria defined
        </p>
      </div>
    );
  }

  const progressPercent = Math.round((metCount / totalCount) * 100);

  return (
    <div className="space-y-3 px-4 py-3" data-testid="acceptance-criteria">
      {/* Summary bar */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase tracking-wider text-text-muted">
          {metCount}/{totalCount} met
        </span>
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-bg-tertiary">
            <div
              className="h-full rounded-full bg-success transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="font-mono text-xs text-text-muted">
            {progressPercent}%
          </span>
        </div>
      </div>

      {/* Criteria list */}
      <div className="space-y-1.5">
        {sortedCriteria.map((criterion, index) => (
          <CriterionItem
            key={`criterion-${criterion.order ?? index}`}
            section={criterion}
            onToggle={() => handleToggle(criterion)}
          />
        ))}
      </div>
    </div>
  );
}
