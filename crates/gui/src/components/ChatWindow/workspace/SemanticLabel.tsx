import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { SourceLocation } from "../../shared/EvidenceNavigationContext";
import type { SymbolLink } from "./relatedSymbols";
import type { SemanticFile } from "./useChangeFiles";
import {
  chipText,
  labelChips,
  summaryCounts,
  summaryDetail,
  type DeclarationSummary,
  type DiffSide,
  type SemanticLabel,
} from "./semanticHunks";
import { factSections, type FactGroup } from "./semanticFacts";

/** Declaration context and structural edits, with facts available on demand. */
export function SemanticLabelRow({
  label,
  onJump,
  related = [],
  onRelatedJump,
  onClose,
}: {
  label: SemanticLabel;
  onJump(line: number, side: DiffSide): void;
  related?: readonly SymbolLink[];
  onRelatedJump?(location: SourceLocation): void;
  onClose?(): void;
}): ReactNode {
  const chips = labelChips(label);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const details = useRef<HTMLDivElement>(null);
  useEffect(() => details.current?.focus({ preventScroll: true }), []);
  const namedEdit = chips.some((chip) => "declaration" in chip && chip.declaration);
  const scope = namedEdit ? undefined : label.scope.at(-1);
  const showFacts = label.facts.length > 0;
  const showLabel = !!scope || label.test || chips.length > 0 || showFacts;
  const showRelated = related.length > 0 && !!onRelatedJump;
  if (!showLabel && !showRelated) return null;
  return (
    <div
      className="semantic-label-block"
      ref={onClose ? details : undefined}
      tabIndex={onClose ? -1 : undefined}
      aria-label={onClose ? "Semantic details" : undefined}
      role={onClose ? "region" : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !onClose) return;
        event.stopPropagation();
        onClose();
      }}
    >
      {showLabel && (
        <div className="semantic-label" data-semantic-label="">
          {(scope || label.test) && (
            <span className="semantic-scope">
              {scope && (
                <span className="semantic-scope-segment">
                  <span className="semantic-scope-keyword">
                    {label.inScope && "In "}{scope.keyword}
                  </span>{" "}
                  {scope.name}
                </span>
              )}
              {label.test && <span className="semantic-test-tag">test</span>}
            </span>
          )}
          {chips.map((chip, index) =>
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
          {showFacts && (
            <button
              ref={button}
              type="button"
              className="semantic-facts-toggle"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((was) => !was)}
            >
              Facts
            </button>
          )}
        </div>
      )}
      {showRelated && onRelatedJump && (
        <RelatedLinks links={related} onJump={onRelatedJump} />
      )}
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

function RelatedLinks({
  links,
  onJump,
}: {
  links: readonly SymbolLink[];
  onJump(location: SourceLocation): void;
}) {
  const linkButton = (link: SymbolLink) => (
    <button
      key={JSON.stringify(link)}
      type="button"
      title={`${link.location.path}:${link.location.line}`}
      onClick={() => onJump(link.location)}
    >
      {link.text} ↗
    </button>
  );
  return (
    <div className="semantic-relations" aria-label="Related changed symbols" role="group">
      {linkButton(links[0])}
      {links.length > 1 && (
        <details>
          <summary>{links.length - 1} more</summary>
          <div className="semantic-relations-list">{links.slice(1).map(linkButton)}</div>
        </details>
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

/** The file header's marker for a file whose every change is whitespace. */
export function FormattingBadge({
  file,
}: {
  file: SemanticFile | null;
}): ReactNode {
  return file?.status === "semantic" && file.view.formattingOnly ? (
    <span
      className="changes-diff-mode"
      title="Every change in this file is whitespace"
    >
      formatting only
    </span>
  ) : null;
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
