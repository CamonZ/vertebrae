import { useMemo } from "react";
import type { Section } from "../../bindings";
import { InlineEditField } from "./InlineEditField";
import { Text } from "../atoms/Text";

interface SpecSectionProps {
  description: string | null;
  sections: Section[];
  onDescriptionChange?: (value: string) => Promise<void>;
}

function SectionList({
  label,
  items,
}: {
  label: string;
  items: Section[];
}) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      <Text variant="eyebrow" color="tertiary" as="h4">
        {label}
      </Text>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li
            key={`${item.type}-${item.order ?? i}`}
            className="flex items-start gap-2 text-sm text-[var(--color-fg-soft)]"
          >
            <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--color-fg-faint)]" />
            <span>{item.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SpecSection({ description, sections, onDescriptionChange }: SpecSectionProps) {
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

  return (
    <div className="space-y-5 px-4 py-2" data-testid="spec-section">
      {grouped.goals.length > 0 && (
        <div className="space-y-2">
          <Text variant="eyebrow" color="tertiary" as="h4">
            Goal
          </Text>
          {grouped.goals.map((goal, i) => (
            <p
              key={`goal-${goal.order ?? i}`}
              className="text-sm text-[var(--color-fg)] leading-relaxed"
            >
              {goal.content}
            </p>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <Text variant="eyebrow" color="tertiary" as="h4">
          Description
        </Text>
        {onDescriptionChange ? (
          <InlineEditField
            value={description || ""}
            placeholder="Click to add description"
            multiline
            rows={3}
            onSave={onDescriptionChange}
          />
        ) : (
          <p className="whitespace-pre-wrap text-sm text-[var(--color-fg-soft)] leading-relaxed">
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
