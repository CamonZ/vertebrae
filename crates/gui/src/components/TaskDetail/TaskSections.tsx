import { useState } from 'react';
import type { Section, SectionType } from '../../bindings';

interface TaskSectionsProps {
  sections: Section[];
}

/**
 * Group sections by type for organized display
 */
function groupSectionsByType(sections: Section[]): Map<SectionType, Section[]> {
  const grouped = new Map<SectionType, Section[]>();

  for (const section of sections) {
    const existing = grouped.get(section.type) ?? [];
    existing.push(section);
    grouped.set(section.type, existing);
  }

  // Sort sections within each group by order
  for (const [type, sectionList] of grouped) {
    sectionList.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    grouped.set(type, sectionList);
  }

  return grouped;
}

/**
 * Format section type for display
 */
function formatSectionType(type: SectionType): string {
  switch (type) {
    case 'goal':
      return 'Goal';
    case 'context':
      return 'Context';
    case 'current_behavior':
      return 'Current Behavior';
    case 'desired_behavior':
      return 'Desired Behavior';
    case 'step':
      return 'Steps';
    case 'testing_criterion':
      return 'Testing Criteria';
    case 'anti_pattern':
      return 'Anti-Patterns';
    case 'failure_test':
      return 'Failure Tests';
    case 'constraint':
      return 'Constraints';
    default:
      return type;
  }
}

/**
 * Get icon for section type
 */
function getSectionIcon(type: SectionType): string {
  switch (type) {
    case 'goal':
      return '\u{1F3AF}'; // Target emoji as fallback, will use SVG
    case 'step':
      return '\u{1F4CB}';
    case 'testing_criterion':
      return '\u{2705}';
    case 'constraint':
      return '\u{26A0}';
    case 'anti_pattern':
      return '\u{1F6AB}';
    default:
      return '\u{1F4DD}';
  }
}

interface SectionGroupProps {
  type: SectionType;
  sections: Section[];
  defaultOpen?: boolean;
}

/**
 * Collapsible section group component
 */
function SectionGroup({ type, sections, defaultOpen = false }: SectionGroupProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-bg-tertiary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-border-focus"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm" aria-hidden="true">
            {getSectionIcon(type)}
          </span>
          <span className="text-sm font-medium text-text-primary">
            {formatSectionType(type)}
          </span>
          <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted">
            {sections.length}
          </span>
        </div>
        <svg
          className={`h-4 w-4 text-text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isOpen && (
        <div className="bg-bg-secondary px-4 pb-3">
          <ul className="space-y-2">
            {sections.map((section, index) => (
              <li
                key={`${type}-${index}`}
                className="flex items-start gap-2 text-sm text-text-secondary"
              >
                {type === 'step' && (
                  <span
                    className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-xs font-medium ${
                      section.done
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-bg-tertiary text-text-muted'
                    }`}
                  >
                    {section.done ? (
                      <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    ) : (
                      (section.order ?? index + 1)
                    )}
                  </span>
                )}
                {type !== 'step' && (
                  <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-text-muted" />
                )}
                <span className={section.done ? 'line-through opacity-60' : ''}>
                  {section.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * TaskSections displays task sections grouped by type in collapsible accordions.
 */
export function TaskSections({ sections }: TaskSectionsProps) {
  if (sections.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-sm text-text-muted">
        No sections defined
      </div>
    );
  }

  const groupedSections = groupSectionsByType(sections);

  // Define display order for section types
  const typeOrder: SectionType[] = [
    'goal',
    'context',
    'current_behavior',
    'desired_behavior',
    'step',
    'constraint',
    'testing_criterion',
    'anti_pattern',
    'failure_test',
  ];

  // Sort groups by predefined order
  const sortedTypes = Array.from(groupedSections.keys()).sort(
    (a, b) => typeOrder.indexOf(a) - typeOrder.indexOf(b)
  );

  return (
    <div className="divide-y divide-border">
      {sortedTypes.map((type) => (
        <SectionGroup
          key={type}
          type={type}
          sections={groupedSections.get(type) ?? []}
          defaultOpen={type === 'goal' || type === 'step'}
        />
      ))}
    </div>
  );
}
