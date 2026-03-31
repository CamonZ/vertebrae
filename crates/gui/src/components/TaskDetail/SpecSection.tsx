import { useMemo } from "react";
import type { Section } from "../../bindings";

interface SpecSectionProps {
  description: string | null;
  sections: Section[];
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
    <div className="space-y-1">
      <h4 className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </h4>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li
            key={`${item.type}-${item.order ?? i}`}
            className="flex items-start gap-2 text-sm text-text-secondary"
          >
            <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-text-muted/40" />
            <span>{item.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SpecSection({ description, sections }: SpecSectionProps) {
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

  const hasContent =
    description ||
    grouped.goals.length > 0 ||
    grouped.constraints.length > 0 ||
    grouped.context.length > 0 ||
    grouped.currentBehavior.length > 0 ||
    grouped.desiredBehavior.length > 0;

  if (!hasContent) {
    return (
      <div className="px-4 py-3">
        <p className="text-xs text-text-muted italic">No spec defined</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 px-4 py-3" data-testid="spec-section">
      {grouped.goals.length > 0 && (
        <div className="space-y-1">
          <h4 className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Goal
          </h4>
          {grouped.goals.map((goal, i) => (
            <p
              key={`goal-${goal.order ?? i}`}
              className="text-sm text-text-primary leading-relaxed"
            >
              {goal.content}
            </p>
          ))}
        </div>
      )}

      {description && (
        <div className="space-y-1">
          <h4 className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Description
          </h4>
          <p className="whitespace-pre-wrap text-sm text-text-secondary leading-relaxed">
            {description}
          </p>
        </div>
      )}

      <SectionList label="Constraints" items={grouped.constraints} />
      <SectionList label="Context" items={grouped.context} />
      <SectionList label="Current Behavior" items={grouped.currentBehavior} />
      <SectionList label="Desired Behavior" items={grouped.desiredBehavior} />
    </div>
  );
}
