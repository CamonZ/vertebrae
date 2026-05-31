import { useMemo } from "react";
import type { Section } from "../../bindings";
import { InlineEditField } from "./InlineEditField";
import { Text } from "../atoms/Text";

interface SpecSectionProps {
  description: string | null;
  sections: Section[];
  onDescriptionChange?: (value: string) => Promise<void>;
}

/** Subsection eyebrow ("Goal", "Description", …). 10px to match the reference
 * `.t-sublbl` (var(--text-10)) — a step down from the 11px eyebrow default. The
 * inline size beats the variant's hardcoded font-size. */
function SubLabel({ children }: { children: string }) {
  return (
    <Text
      variant="eyebrow"
      color="faint"
      as="h4"
      style={{ fontSize: "var(--text-2xs)" }}
    >
      {children}
    </Text>
  );
}

function SectionList({ label, items }: { label: string; items: Section[] }) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <SubLabel>{label}</SubLabel>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li
            key={`${item.type}-${item.order ?? i}`}
            className="flex items-start gap-2 text-[13px] text-[var(--color-fg-soft)]"
          >
            <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--color-fg-faint)]" />
            <span>{item.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SpecSection({
  description,
  sections,
  onDescriptionChange,
}: SpecSectionProps) {
  const grouped = useMemo(() => {
    const result = {
      goals: [] as Section[],
      constraints: [] as Section[],
      context: [] as Section[],
      currentBehavior: [] as Section[],
      desiredBehavior: [] as Section[],
    };
    for (const s of sections) {
      switch (s.type) {
        case "goal":
          result.goals.push(s);
          break;
        case "constraint":
          result.constraints.push(s);
          break;
        case "context":
          result.context.push(s);
          break;
        case "current_behavior":
          result.currentBehavior.push(s);
          break;
        case "desired_behavior":
          result.desiredBehavior.push(s);
          break;
      }
    }
    return result;
  }, [sections]);

  // Always render — description is always shown (editable when callback provided)

  // No horizontal padding here: the accordion body already insets content to
  // var(--s-5), which lines the subtitles up with the header chevron (per the
  // reference `.t-sublbl`, flush with the accordion body's left edge). No top
  // padding either — the header's own bottom padding sets the gap to the first
  // subtitle. Vertical rhythm: var(--s-4) (16px) between subsections,
  // var(--s-1h) (6px) label→prose.
  return (
    <div className="space-y-4 pb-2" data-testid="spec-section">
      {grouped.goals.length > 0 && (
        <div className="space-y-1.5">
          <SubLabel>Goal</SubLabel>
          {grouped.goals.map((goal, i) => (
            <p
              key={`goal-${goal.order ?? i}`}
              className="text-[13px] text-[var(--color-fg)] leading-relaxed"
            >
              {goal.content}
            </p>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <SubLabel>Description</SubLabel>
        {onDescriptionChange ? (
          <InlineEditField
            value={description || ""}
            placeholder="Click to add description"
            multiline
            rows={3}
            onSave={onDescriptionChange}
            // Render flush prose (no padded click-box) so the editable
            // description lines up with the Goal body and the subtitle above it.
            displayPadding="p-0"
            renderDisplay={(v) => (
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-fg-soft)]">
                {v}
              </p>
            )}
          />
        ) : (
          <p className="whitespace-pre-wrap text-[13px] text-[var(--color-fg-soft)] leading-relaxed">
            {description || (
              <span className="italic text-[var(--color-fg-mute)]">
                No description
              </span>
            )}
          </p>
        )}
      </div>

      <SectionList label="Constraints" items={grouped.constraints} />
      <SectionList label="Context" items={grouped.context} />
      <SectionList label="Current Behavior" items={grouped.currentBehavior} />
      <SectionList label="Desired Behavior" items={grouped.desiredBehavior} />
    </div>
  );
}
