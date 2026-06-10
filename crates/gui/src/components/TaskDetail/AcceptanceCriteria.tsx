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

function StatusIndicator({ status }: { status: CriterionStatus }) {
  switch (status) {
    case "met":
      return (
        <div className="flex h-5 w-5 items-center justify-center rounded-[var(--radius-xs)] bg-[var(--color-accent)] text-[var(--color-bg)]">
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
        <div className="flex h-5 w-5 items-center justify-center rounded-[var(--radius-xs)] bg-[var(--color-err-wash)] text-[var(--color-err)]">
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
        <div className="h-5 w-5 rounded-[var(--radius-xs)] border border-[var(--color-line-strong)]" />
      );
  }
}

/**
 * Marks a criterion as machine-verifiable. Shown only when the criterion has
 * code refs (real data) — there is no validation-type field, so we don't
 * fabricate a "human" counterpart for criteria that simply lack refs.
 */
function ValidationBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-info-wash)] px-2 py-0.5 text-2xs font-medium text-[var(--color-info)]">
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
            className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-bg-2)] px-1.5 py-0.5 font-mono text-2xs text-[var(--color-fg-mute)]"
            title={ref.description ?? ref.path}
          >
            {ref.path.split("/").pop()}
            {lineRange && (
              <span className="text-[var(--color-accent)]">{lineRange}</span>
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
  const refs = section.refs ?? [];

  return (
    <div
      className={`flex items-start gap-3 rounded-[var(--radius-lg)] px-3 py-2.5 transition-colors ${
        status === "not_met"
          ? "bg-[var(--color-err-wash)]"
          : "bg-transparent"
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
                ? "text-[var(--color-fg-mute)] line-through"
                : "text-[var(--color-fg)]"
            }`}
          >
            {section.content}
          </p>
          {refs.length > 0 && <ValidationBadge />}
        </div>
        <CriterionRefsList refs={refs} />
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
        <p className="text-sm text-[var(--color-fg-mute)] italic">
          No test criteria defined
        </p>
      </div>
    );
  }

  const progressPercent = Math.round((metCount / totalCount) * 100);

  return (
    <div className="space-y-3 px-4 py-3" data-testid="acceptance-criteria">
      {/* Summary bar */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-2xs uppercase tracking-wider text-[var(--color-fg-mute)]">
          {metCount}/{totalCount} met
        </span>
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--color-bg-2)]">
            <div
              className="h-full rounded-full bg-[var(--color-accent)] transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="font-mono text-2xs text-[var(--color-fg-mute)]">
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
