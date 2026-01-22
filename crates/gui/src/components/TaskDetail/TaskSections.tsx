import { useState, useCallback, useEffect } from 'react';
import type { Section, SectionType } from '../../bindings';
import { commands } from '../../bindings';
import { InlineEditField } from './InlineEditField';

interface TaskSectionsProps {
  sections: Section[];
  taskId: string;
  onSectionsChanged?: () => void;
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
 * Get short label for section type buttons
 */
function getShortLabel(type: SectionType): string {
  switch (type) {
    case 'goal':
      return 'Goal';
    case 'context':
      return 'Context';
    case 'current_behavior':
      return 'Current';
    case 'desired_behavior':
      return 'Desired';
    case 'step':
      return 'Step';
    case 'testing_criterion':
      return 'Test';
    case 'anti_pattern':
      return 'Anti';
    case 'failure_test':
      return 'Fail';
    case 'constraint':
      return 'Constraint';
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
      return '\u{1F3AF}';
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
  taskId: string;
  isAddingNew?: boolean;
  onAddComplete: () => void;
  onSectionsChanged?: () => void;
}

/**
 * Collapsible section group component with inline editing
 */
function SectionGroup({
  type,
  sections,
  defaultOpen = false,
  taskId,
  isAddingNew = false,
  onAddComplete,
  onSectionsChanged
}: SectionGroupProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen || isAddingNew);
  const [editingOrder, setEditingOrder] = useState<number | null>(null);
  const [deletingOrder, setDeletingOrder] = useState<number | null>(null);

  // Auto-open when adding new
  useEffect(() => {
    if (isAddingNew) {
      setIsOpen(true);
    }
  }, [isAddingNew]);

  const handleToggleDone = useCallback(async (section: Section) => {
    try {
      const result = await commands.markSectionDone(taskId, section.order ?? 0);
      if (result.status === 'error') {
        console.error('Failed to toggle done:', result.error.message);
      } else {
        onSectionsChanged?.();
      }
    } catch (err) {
      console.error('Failed to toggle done:', err);
    }
  }, [taskId, onSectionsChanged]);

  const handleDeleteSection = useCallback(async (order: number) => {
    setDeletingOrder(order);
    try {
      const result = await commands.removeSection(taskId, type, order);
      if (result.status === 'error') {
        console.error('Failed to delete section:', result.error.message);
      } else {
        onSectionsChanged?.();
      }
    } catch (err) {
      console.error('Failed to delete section:', err);
    } finally {
      setDeletingOrder(null);
      setEditingOrder(null);
    }
  }, [taskId, type, onSectionsChanged]);

  const handleAddSection = useCallback(async (content: string) => {
    const result = await commands.addSection(taskId, type, content);
    if (result.status === 'error') {
      throw new Error(result.error.message);
    }
    onAddComplete();
    onSectionsChanged?.();
  }, [taskId, type, onAddComplete, onSectionsChanged]);

  const handleEditSection = useCallback(async (section: Section, content: string) => {
    const result = await commands.editSection(
      taskId,
      section.type,
      section.order ?? 0,
      content
    );
    if (result.status === 'error') {
      throw new Error(result.error.message);
    }
    setEditingOrder(null);
    onSectionsChanged?.();
  }, [taskId, onSectionsChanged]);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-bg-tertiary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-border-focus cursor-pointer"
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
                key={`${type}-${section.order ?? index}`}
                className="group flex items-start gap-2 text-sm text-text-secondary rounded-md p-2 hover:bg-bg-tertiary transition-colors"
              >
                {type === 'step' && (
                  <button
                    type="button"
                    onClick={() => handleToggleDone(section)}
                    className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-xs font-medium cursor-pointer transition-colors ${
                      section.done
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-bg-tertiary text-text-muted hover:border hover:border-primary'
                    }`}
                    title={section.done ? 'Mark as not done' : 'Mark as done'}
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
                  </button>
                )}
                {type !== 'step' && (
                  <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-text-muted" />
                )}

                {editingOrder === (section.order ?? index) ? (
                  <InlineEditField
                    value={section.content}
                    onSave={async (content) => handleEditSection(section, content)}
                    onCancel={() => setEditingOrder(null)}
                    onDelete={() => handleDeleteSection(section.order ?? index)}
                    isDeleting={deletingOrder === (section.order ?? index)}
                    allowEmpty={false}
                    startInEditMode
                    compact
                  />
                ) : (
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => setEditingOrder(section.order ?? index)}
                    title="Click to edit"
                  >
                    <span className={section.done ? 'line-through opacity-60' : ''}>
                      {section.content}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {/* Inline add form using InlineEditField */}
          {isAddingNew && (
            <div className="mt-2 p-2 bg-bg-tertiary rounded-md">
              <InlineEditField
                value=""
                placeholder={`Add ${formatSectionType(type).toLowerCase()}...`}
                onSave={handleAddSection}
                onCancel={onAddComplete}
                allowEmpty={false}
                startInEditMode
                clearOnSave
                compact
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// All available section types
const ALL_SECTION_TYPES: SectionType[] = [
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

// Define display order for section types
const TYPE_ORDER: SectionType[] = [
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

/**
 * TaskSections displays task sections grouped by type in collapsible accordions.
 * Uses InlineEditField for consistent inline editing UX.
 */
export function TaskSections({ sections, taskId, onSectionsChanged }: TaskSectionsProps) {
  const [showTypeSelector, setShowTypeSelector] = useState(false);
  const [addingToType, setAddingToType] = useState<SectionType | null>(null);

  const groupedSections = groupSectionsByType(sections);

  // Sort groups by predefined order
  const sortedTypes = Array.from(groupedSections.keys()).sort(
    (a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b)
  );

  // Types that have sections
  const typesWithSections = new Set(sortedTypes);

  // Types to show in the main list (those with sections + the one being added to)
  const displayTypes = [...sortedTypes];
  if (addingToType && !typesWithSections.has(addingToType)) {
    // Insert the adding type in the correct position
    const insertIndex = TYPE_ORDER.indexOf(addingToType);
    let placed = false;
    for (let i = 0; i < displayTypes.length; i++) {
      if (TYPE_ORDER.indexOf(displayTypes[i]) > insertIndex) {
        displayTypes.splice(i, 0, addingToType);
        placed = true;
        break;
      }
    }
    if (!placed) {
      displayTypes.push(addingToType);
    }
  }

  const handleTypeSelect = useCallback((type: SectionType) => {
    setAddingToType(type);
    setShowTypeSelector(false);
  }, []);

  const handleAddComplete = useCallback(() => {
    setAddingToType(null);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Add section area */}
      <div className="border-b border-border p-4">
        {showTypeSelector ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-primary">Select type:</span>
              <button
                type="button"
                onClick={() => setShowTypeSelector(false)}
                className="p-1 rounded text-text-muted hover:bg-bg-tertiary hover:text-text-primary transition-colors cursor-pointer"
                title="Cancel"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ALL_SECTION_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => handleTypeSelect(type)}
                  className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-border bg-bg-secondary hover:bg-bg-tertiary hover:border-primary transition-colors cursor-pointer"
                >
                  {getShortLabel(type)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowTypeSelector(true)}
            disabled={addingToType !== null}
            className="w-full rounded-lg border border-dashed border-primary/30 bg-primary/5 px-4 py-2.5 text-sm font-medium text-primary hover:bg-primary/10 hover:border-primary/50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg className="inline h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Section
          </button>
        )}
      </div>

      {/* Sections list */}
      <div className="flex-1 overflow-auto">
        {displayTypes.length === 0 && !addingToType ? (
          <div className="px-4 py-6 text-center text-sm text-text-muted">
            No sections defined
          </div>
        ) : (
          <div className="divide-y divide-border">
            {displayTypes.map((type) => (
              <SectionGroup
                key={type}
                type={type}
                sections={groupedSections.get(type) ?? []}
                defaultOpen={type === 'goal' || type === 'step'}
                taskId={taskId}
                isAddingNew={addingToType === type}
                onAddComplete={handleAddComplete}
                onSectionsChanged={onSectionsChanged}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
