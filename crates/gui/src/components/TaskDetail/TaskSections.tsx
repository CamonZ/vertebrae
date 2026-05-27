import { useState, useCallback, useEffect } from 'react';
import type { Section, SectionType } from '../../bindings';
import { commands } from '../../bindings';
import { EditableList } from '../EditableList';
import { InlineEditField } from './InlineEditField';
import { SectionGroup as SharedSectionGroup } from '../molecules/SectionGroup';
import { Chip } from '../atoms/Chip';
import { Button } from '../atoms/Button';

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
    case 'checklist_item':
      return 'Checklist Items';
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
    case 'checklist_item':
      return 'Checklist';
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
    case 'checklist_item':
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

  // Auto-open when adding new
  useEffect(() => {
    if (isAddingNew) {
      setIsOpen(true);
    }
  }, [isAddingNew]);

  const handleToggleDone = useCallback(async (index: number) => {
    const section = sections[index];
    if (!section) return;
    try {
      const result = await commands.toggleChecklistItemDone(taskId, section.order ?? 0);
      if (result.status === 'error') {
        console.error('Failed to toggle done:', result.error.message);
      } else {
        onSectionsChanged?.();
      }
    } catch (err) {
      console.error('Failed to toggle done:', err);
    }
  }, [taskId, sections, onSectionsChanged]);

  const handleDeleteSection = useCallback(async (index: number) => {
    const section = sections[index];
    if (!section) return;
    try {
      const result = await commands.removeSection(taskId, type, section.order ?? 0);
      if (result.status === 'error') {
        console.error('Failed to delete section:', result.error.message);
      } else {
        onSectionsChanged?.();
      }
    } catch (err) {
      console.error('Failed to delete section:', err);
    }
  }, [taskId, type, sections, onSectionsChanged]);

  const handleAddSection = useCallback(async (content: string) => {
    const result = await commands.addSection(taskId, type, content);
    if (result.status === 'error') {
      throw new Error(result.error.message);
    }
    onAddComplete();
    onSectionsChanged?.();
  }, [taskId, type, onAddComplete, onSectionsChanged]);

  const handleEditSection = useCallback(async (index: number, content: string) => {
    const section = sections[index];
    if (!section) return;
    const result = await commands.editSection(
      taskId,
      section.type,
      section.order ?? 0,
      content
    );
    if (result.status === 'error') {
      throw new Error(result.error.message);
    }
    onSectionsChanged?.();
  }, [taskId, sections, onSectionsChanged]);

  // Prepare data for EditableList
  const items = sections.map(s => s.content);
  const itemStates = sections.map(s => ({ done: s.done ?? false }));

  return (
    <SharedSectionGroup
      open={isOpen}
      onOpenChange={setIsOpen}
      ariaLabel={`Toggle ${formatSectionType(type)} section`}
      icon={<span aria-hidden="true">{getSectionIcon(type)}</span>}
      label={formatSectionType(type)}
      count={sections.length}
    >
      {/* Only mount section content while open so collapsed sections stay out
          of the accessibility tree (matches the prior conditional render). */}
      {!isOpen ? null : isAddingNew ? (
        <>
          <EditableList
            items={items}
            emptyText={`No ${formatSectionType(type).toLowerCase()}`}
            placeholder={`Add ${formatSectionType(type).toLowerCase()}...`}
            onAdd={handleAddSection}
            onEdit={handleEditSection}
            onDelete={handleDeleteSection}
            variant={type === 'checklist_item' ? 'step' : 'bullet'}
            itemStates={itemStates}
            onToggleDone={handleToggleDone}
          />
          {/* Show the add form when isAddingNew */}
          <div className="mt-2 p-2 bg-[var(--color-bg-2)] rounded-[var(--radius-md)]">
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
        </>
      ) : (
        <EditableList
          items={items}
          emptyText={`No ${formatSectionType(type).toLowerCase()}`}
          placeholder={`Add ${formatSectionType(type).toLowerCase()}...`}
          onAdd={handleAddSection}
          onEdit={handleEditSection}
          onDelete={handleDeleteSection}
          variant={type === 'checklist_item' ? 'step' : 'bullet'}
          itemStates={itemStates}
          onToggleDone={handleToggleDone}
        />
      )}
    </SharedSectionGroup>
  );
}

// All available section types
const ALL_SECTION_TYPES: SectionType[] = [
  'goal',
  'context',
  'current_behavior',
  'desired_behavior',
  'checklist_item',
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
  'checklist_item',
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
      <div className="border-b border-[var(--color-line)] p-4">
        {showTypeSelector ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-[var(--color-fg)]">Select type:</span>
              <button
                type="button"
                onClick={() => setShowTypeSelector(false)}
                className="p-1 rounded-[var(--radius-sm)] text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)] transition-colors cursor-pointer"
                title="Cancel"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ALL_SECTION_TYPES.map((type) => (
                <Chip
                  key={type}
                  variant="filter"
                  onClick={() => handleTypeSelect(type)}
                >
                  {getShortLabel(type)}
                </Chip>
              ))}
            </div>
          </div>
        ) : (
          <Button
            variant="secondary"
            fullWidth
            onClick={() => setShowTypeSelector(true)}
            disabled={addingToType !== null}
            iconLeft={
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            }
          >
            Add Section
          </Button>
        )}
      </div>

      {/* Sections list */}
      <div className="flex-1 overflow-auto">
        {displayTypes.length === 0 && !addingToType ? (
          <div className="px-4 py-6 text-center text-sm text-[var(--color-fg-mute)]">
            No sections defined
          </div>
        ) : (
          <div>
            {displayTypes.map((type) => (
              <SectionGroup
                key={type}
                type={type}
                sections={groupedSections.get(type) ?? []}
                defaultOpen={type === 'goal' || type === 'checklist_item'}
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
