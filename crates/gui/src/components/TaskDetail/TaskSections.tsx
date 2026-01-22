import { useState, useCallback } from 'react';
import type { Section, SectionType } from '../../bindings';
import { commands } from '../../bindings';
import { SectionEditor } from './SectionEditor';
import { StepEditor } from './StepEditor';
import { TestingCriterionEditor } from './TestingCriterionEditor';

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
  taskId: string;
  onSectionsChanged?: () => void;
}

/**
 * Collapsible section group component
 */
function SectionGroup({ type, sections, defaultOpen = false, taskId, onSectionsChanged }: SectionGroupProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [editingSection, setEditingSection] = useState<Section | null>(null);
  const [deletingOrdinal, setDeletingOrdinal] = useState<number | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteSection = useCallback(async () => {
    if (deletingOrdinal === null) return;

    setIsDeleting(true);
    try {
      const result = await commands.removeSection(taskId, type, deletingOrdinal);
      if (result.status === 'error') {
        console.error('Failed to delete section:', result.error.message);
      } else {
        onSectionsChanged?.();
      }
    } catch (err) {
      console.error('Failed to delete section:', err);
    } finally {
      setIsDeleting(false);
      setDeleteConfirmOpen(false);
      setDeletingOrdinal(null);
    }
  }, [taskId, type, deletingOrdinal, onSectionsChanged]);

  const handleConfirmDelete = useCallback((ordinal: number) => {
    setDeletingOrdinal(ordinal);
    setDeleteConfirmOpen(true);
  }, []);

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
                key={`${type}-${index}`}
                className="group flex items-start gap-2 text-sm text-text-secondary rounded-md p-2 hover:bg-bg-tertiary transition-colors"
              >
                {type === 'step' && (
                  <span
                    className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-xs font-medium cursor-pointer ${
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
                <div className="flex-1 min-w-0">
                  <span className={section.done ? 'line-through opacity-60' : ''}>
                    {section.content}
                  </span>
                </div>
                <div className="flex-shrink-0 gap-1 flex opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => setEditingSection(section)}
                    className="p-1 rounded text-text-muted hover:bg-bg-tertiary hover:text-text-primary transition-colors cursor-pointer"
                    title="Edit section"
                    aria-label="Edit section"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleConfirmDelete(section.ordinal ?? index)}
                    className="p-1 rounded text-text-muted hover:bg-error/10 hover:text-error transition-colors cursor-pointer"
                    title="Delete section"
                    aria-label="Delete section"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm cursor-pointer" onClick={() => setDeleteConfirmOpen(false)} />
          <div className="relative bg-background-secondary rounded-lg shadow-xl max-w-sm w-full mx-4 p-6">
            <h3 className="text-lg font-semibold text-text-primary mb-2">Delete Section?</h3>
            <p className="text-sm text-text-secondary mb-6">
              This action cannot be undone. The section will be permanently deleted.
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeleteConfirmOpen(false)}
                disabled={isDeleting}
                className="px-4 py-2 text-sm font-medium rounded-md border border-border hover:bg-background-tertiary transition-colors disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteSection}
                disabled={isDeleting}
                className="px-4 py-2 text-sm font-medium rounded-md bg-error/10 text-error hover:bg-error/20 transition-colors disabled:opacity-50"
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit modals */}
      {editingSection && type === 'step' ? (
        <StepEditor
          taskId={taskId}
          step={editingSection}
          isOpen={true}
          onClose={() => setEditingSection(null)}
          onSave={() => {
            setEditingSection(null);
            onSectionsChanged?.();
          }}
        />
      ) : editingSection && type === 'testing_criterion' ? (
        <TestingCriterionEditor
          taskId={taskId}
          criterion={editingSection}
          isOpen={true}
          onClose={() => setEditingSection(null)}
          onSave={() => {
            setEditingSection(null);
            onSectionsChanged?.();
          }}
        />
      ) : (
        editingSection && (
          <SectionEditor
            taskId={taskId}
            section={editingSection}
            sectionType={type}
            isOpen={true}
            onClose={() => setEditingSection(null)}
            onSave={() => {
              setEditingSection(null);
              onSectionsChanged?.();
            }}
          />
        )
      )}
    </div>
  );
}

/**
 * TaskSections displays task sections grouped by type in collapsible accordions.
 */
export function TaskSections({ sections, taskId, onSectionsChanged }: TaskSectionsProps) {
  const [newSectionType, setNewSectionType] = useState<SectionType | null>(null);
  const [showNewSection, setShowNewSection] = useState(false);

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

  // All available section types for creation
  const allSectionTypes: SectionType[] = [
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

  const handleNewSectionTypeSelect = useCallback((type: SectionType) => {
    setNewSectionType(type);
    setShowNewSection(true);
  }, []);

  const handleNewSectionClose = useCallback(() => {
    setShowNewSection(false);
    setNewSectionType(null);
  }, []);

  const handleNewSectionSave = useCallback(() => {
    handleNewSectionClose();
    onSectionsChanged?.();
  }, [handleNewSectionClose, onSectionsChanged]);

  return (
    <div className="flex flex-col h-full">
      {/* New section button */}
      <div className="border-b border-border p-4">
        <button
          type="button"
          onClick={() => setShowNewSection(true)}
          className="w-full rounded-lg border border-dashed border-primary/30 bg-primary/5 px-4 py-2.5 text-sm font-medium text-primary hover:bg-primary/10 hover:border-primary/50 transition-colors cursor-pointer"
        >
          <svg className="inline h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Section
        </button>
      </div>

      {/* Sections list */}
      <div className="flex-1 overflow-auto">
        {sections.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-text-muted">
            No sections defined
          </div>
        ) : (
          <div className="divide-y divide-border">
            {sortedTypes.map((type) => (
              <SectionGroup
                key={type}
                type={type}
                sections={groupedSections.get(type) ?? []}
                defaultOpen={type === 'goal' || type === 'step'}
                taskId={taskId}
                onSectionsChanged={onSectionsChanged}
              />
            ))}
          </div>
        )}
      </div>

      {/* Section type selector modal */}
      {showNewSection && !newSectionType && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm cursor-pointer" onClick={handleNewSectionClose} />
          <div className="relative bg-background-secondary rounded-lg shadow-xl max-w-sm w-full mx-4 p-6">
            <h3 className="text-lg font-semibold text-text-primary mb-4">Create New Section</h3>
            <div className="grid grid-cols-2 gap-2 max-h-96 overflow-y-auto">
              {allSectionTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => handleNewSectionTypeSelect(type)}
                  className="p-3 text-left rounded-lg border border-border hover:bg-background-tertiary hover:border-primary transition-colors cursor-pointer"
                >
                  <div className="font-medium text-sm text-text-primary">
                    {formatSectionType(type)}
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={handleNewSectionClose}
                className="px-4 py-2 text-sm font-medium rounded-md border border-border hover:bg-background-tertiary transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Section editors for new sections */}
      {newSectionType === 'step' && showNewSection ? (
        <StepEditor
          taskId={taskId}
          isOpen={true}
          onClose={handleNewSectionClose}
          onSave={handleNewSectionSave}
        />
      ) : newSectionType === 'testing_criterion' && showNewSection ? (
        <TestingCriterionEditor
          taskId={taskId}
          isOpen={true}
          onClose={handleNewSectionClose}
          onSave={handleNewSectionSave}
        />
      ) : (
        newSectionType && showNewSection && (
          <SectionEditor
            taskId={taskId}
            sectionType={newSectionType}
            isOpen={true}
            onClose={handleNewSectionClose}
            onSave={handleNewSectionSave}
          />
        )
      )}
    </div>
  );
}
