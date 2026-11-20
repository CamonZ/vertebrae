import type { ReactNode } from "react";
import type { SemanticFile } from "./useChangeFiles";
import {
  FALLBACK_TEXT,
  chipText,
  summaryCounts,
  summaryDetail,
  type DeclarationSummary,
  type DiffSide,
  type SemanticLabel,
} from "./semanticHunks";

/**
 * A structural change label under a changed line: the enclosing
 * declarations, then what happened. A moved copy links to the other copy.
 */
export function SemanticLabelRow({
  label,
  onJump,
}: {
  label: SemanticLabel;
  onJump(line: number, side: DiffSide): void;
}): ReactNode {
  return (
    <div className="semantic-label" data-semantic-label="">
      {label.scope.length > 0 && (
        <span className="semantic-scope">
          {label.scope.map((segment, index) => (
            <span key={index} className="semantic-scope-segment">
              <span className="semantic-scope-keyword">{segment.keyword}</span>{" "}
              {segment.name}
            </span>
          ))}
        </span>
      )}
      {label.chips.map((chip, index) =>
        chip.kind === "moved" ? (
          <button
            key={index}
            type="button"
            className="semantic-chip semantic-chip--moved"
            title={`Go to the ${chip.direction === "from" ? "old" : "new"} location`}
            onClick={() => onJump(chip.line, chip.side)}
          >
            {chipText(chip)} ↗
          </button>
        ) : (
          <span key={index} className={`semantic-chip semantic-chip--${chip.kind}`}>
            {chipText(chip)}
          </span>
        )
      )}
    </div>
  );
}

/**
 * The file header's diff mode marker in semantic mode: nothing while
 * loading or when the semantic diff applies, `formatting only` when it
 * finds no change, `line diff` (with the reason) when it does not apply.
 */
export function DiffModeBadge({
  file,
}: {
  file: SemanticFile | null;
}): ReactNode {
  if (!file) return null;
  if (file.status === "semantic")
    return file.view.formattingOnly ? (
      <span
        className="changes-diff-mode"
        title="Every change in this file is whitespace"
      >
        formatting only
      </span>
    ) : null;
  const reason = FALLBACK_TEXT[file.reason];
  return (
    <span
      className="changes-diff-mode"
      title={file.message ? `${reason}: ${file.message}` : reason}
    >
      line diff
    </span>
  );
}

/**
 * The file header's count of declarations added, removed, renamed and
 * moved, e.g. `2 added · 1 renamed`; each one is listed in the tooltip.
 */
export function DeclarationCounts({ summary }: { summary: DeclarationSummary }): ReactNode {
  const counts = summaryCounts(summary);
  if (!counts) return null;
  const detail = summaryDetail(summary);
  return (
    <span className="changes-declarations" title={detail} aria-label={`Declarations: ${detail}`}>
      {counts}
    </span>
  );
}
