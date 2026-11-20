import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
import {
  categoryOf,
  countText,
  factChips,
  factSections,
  factText,
  type FactGroup,
} from "./semanticFacts";

/**
 * A structural change label under a changed line, on one row: the
 * enclosing declarations (tagged when they are test code), what happened,
 * then what kind of code it touches. A moved copy links to the other copy.
 * Facts that do not fit fold into a `+N more` button whose panel lists
 * every fact by declaration and category.
 */
export function SemanticLabelRow({
  label,
  onJump,
}: {
  label: SemanticLabel;
  onJump(line: number, side: DiffSide): void;
}): ReactNode {
  const { chips: facts, hidden } = factChips(label.facts);
  const summarized = facts.some((chip) => chip.kind === "count");
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  return (
    <div className="semantic-label-block">
      <div className="semantic-label" data-semantic-label="">
        {(label.scope.length > 0 || label.test) && (
          <span className="semantic-scope">
            {label.scope.map((segment, index) => (
              <span key={index} className="semantic-scope-segment">
                <span className="semantic-scope-keyword">{segment.keyword}</span>{" "}
                {segment.name}
              </span>
            ))}
            {label.test && <span className="semantic-test-tag">test</span>}
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
        {facts.length > 0 && (
          <span className="semantic-facts">
            {facts.map((chip, index) =>
              chip.kind === "fact" ? (
                <span
                  key={index}
                  className={`semantic-fact semantic-fact--${categoryOf(chip.fact.kind)}`}
                  data-semantic-fact={chip.fact.kind.type}
                >
                  {factText(chip.fact)}
                </span>
              ) : (
                <span
                  key={index}
                  className="semantic-fact semantic-fact--count"
                  data-semantic-fact-count={chip.category}
                >
                  {countText(chip.category, chip.count)}
                </span>
              )
            )}
          </span>
        )}
        {(hidden > 0 || summarized) && (
          <button
            ref={button}
            type="button"
            className="semantic-fact semantic-fact--more"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((was) => !was)}
          >
            {hidden > 0 ? `+${hidden} more` : "all facts"}
          </button>
        )}
      </div>
      {open && (
        <FactPanel
          id={panelId}
          groups={label.facts}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/** Every fact of a label, by declaration and category; Escape closes it. */
function FactPanel({
  id,
  groups,
  onClose,
}: {
  id: string;
  groups: readonly FactGroup[];
  onClose(): void;
}): ReactNode {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => panel.current?.focus(), []);
  const sections = factSections(groups);
  return (
    <div
      ref={panel}
      id={id}
      role="region"
      aria-label="Facts"
      tabIndex={-1}
      className="semantic-facts-panel"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      {sections.map((section, index) => (
        <section key={index} className="semantic-facts-section">
          {sections.length > 1 && section.owner && (
            <h4 className="semantic-facts-owner">
              <span className="semantic-scope-keyword">{section.owner.keyword}</span>{" "}
              {section.owner.name}
            </h4>
          )}
          {section.categories.map((category) => (
            <div key={category.name} className="semantic-facts-category">
              <h5>{category.name}</h5>
              <ul>
                {category.facts.map((fact, i) => (
                  <li key={i}>{fact}</li>
                ))}
              </ul>
            </div>
          ))}
          {section.omitted > 0 && (
            <p className="semantic-facts-omitted">
              {section.omitted} more not listed
            </p>
          )}
        </section>
      ))}
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
