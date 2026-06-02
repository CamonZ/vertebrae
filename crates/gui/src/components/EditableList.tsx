import { useState, useCallback } from "react";
import { InlineEditField } from "./TaskDetail/InlineEditField";

interface EditableListProps {
  items: string[];
  emptyText: string;
  placeholder?: string;
  onAdd: (value: string) => Promise<void>;
  onEdit: (index: number, value: string) => Promise<void>;
  onDelete: (index: number) => void;
  /** Variant: "bullet" shows dots, "step" shows numbered checkboxes */
  variant?: "bullet" | "step";
  /** Done states for each item (only used with variant="step") */
  itemStates?: { done?: boolean }[];
  /** Callback when a step checkbox is toggled */
  onToggleDone?: (index: number) => void;
  /** Use monospace font for item text */
  monospace?: boolean;
}

/**
 * Editable list component with bullet points or numbered checkboxes and inline editing.
 * Supports both simple bullet lists and step lists with done states.
 */
export function EditableList({
  items,
  emptyText,
  placeholder = "Add item...",
  onAdd,
  onEdit,
  onDelete,
  variant = "bullet",
  itemStates,
  onToggleDone,
  monospace = false,
}: EditableListProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null);

  const handleEdit = useCallback(
    async (index: number, value: string) => {
      await onEdit(index, value);
      setEditingIndex(null);
    },
    [onEdit]
  );

  const handleDelete = useCallback(
    (index: number) => {
      setDeletingIndex(index);
      onDelete(index);
      setDeletingIndex(null);
      setEditingIndex(null);
    },
    [onDelete]
  );

  return (
    <div className="space-y-1">
      {items.length === 0 ? (
        <p className="text-xs italic text-fg-mute py-1">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item, index) => {
            const isDone = itemStates?.[index]?.done ?? false;

            return (
              <li
                key={`${item}-${index}`}
                className="group flex items-start gap-2 text-sm text-fg-soft rounded-md p-2 hover:bg-bg-2 transition-colors"
              >
                {variant === "step" ? (
                  <button
                    type="button"
                    onClick={() => onToggleDone?.(index)}
                    className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-xs font-medium cursor-pointer transition-colors ${
                      isDone
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        : "bg-bg-2 text-fg-mute hover:border hover:border-accent"
                    }`}
                    title={isDone ? "Mark as not done" : "Mark as done"}
                  >
                    {isDone ? (
                      <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    ) : (
                      index + 1
                    )}
                  </button>
                ) : (
                  <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-fg-mute" />
                )}

                {editingIndex === index ? (
                  <InlineEditField
                    value={item}
                    onSave={async (content) => handleEdit(index, content)}
                    onCancel={() => setEditingIndex(null)}
                    onDelete={() => handleDelete(index)}
                    isDeleting={deletingIndex === index}
                    allowEmpty={false}
                    startInEditMode
                    compact
                  />
                ) : (
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => setEditingIndex(index)}
                    title="Click to edit"
                  >
                    <span
                      className={`${monospace ? "font-mono text-xs" : ""} ${
                        isDone ? "line-through opacity-60" : ""
                      }`}
                    >
                      {item}
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Add new item */}
      <div className="pt-1">
        <InlineEditField
          value=""
          placeholder={placeholder}
          onSave={async (value) => {
            if (value.trim()) {
              await onAdd(value.trim());
            }
          }}
          compact
          clearOnSave
        />
      </div>
    </div>
  );
}
