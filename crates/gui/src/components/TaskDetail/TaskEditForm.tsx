import { useState, useCallback, useEffect } from "react";
import { FormModal } from "../forms/FormModal";
import { FormField } from "../forms/FormField";
import { commands } from "../../bindings";
import type { Task, TaskLevel, TaskPriority } from "../../bindings";

export interface TaskEditFormProps {
  /** The task ID being edited */
  taskId: string;
  /** Current task data to pre-populate the form */
  currentTask: Task;
  /** Called when the modal should close */
  onClose: () => void;
  /** Called when the update is successful */
  onSuccess: () => void;
}

/**
 * TaskEditForm component for editing existing tasks.
 *
 * Features:
 * - Modal form with all task fields (title, description, level, priority, tags)
 * - Pre-populated with current task data
 * - Validates required fields (title, description)
 * - Calls update_task Tauri command on submission
 * - Shows loading state during submission
 * - Displays error messages on failure
 * - Reuses FormModal and FormField components for consistent styling
 *
 * @example
 * ```tsx
 * <TaskEditForm
 *   taskId="task-123"
 *   currentTask={task}
 *   onClose={() => setIsEditOpen(false)}
 *   onSuccess={() => {
 *     setIsEditOpen(false);
 *     refetchTask();
 *   }}
 * />
 * ```
 */
export function TaskEditForm({
  taskId,
  currentTask,
  onClose,
  onSuccess,
}: TaskEditFormProps) {
  // Form state
  const [title, setTitle] = useState(currentTask.title);
  const [description, setDescription] = useState(currentTask.description ?? "");
  const [level, setLevel] = useState<TaskLevel>(currentTask.level);
  const [priority, setPriority] = useState<TaskPriority | null>(
    currentTask.priority ?? null
  );
  const [tagsInput, setTagsInput] = useState(currentTask.tags.join(", "));

  // UI state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  // Reset form when currentTask changes (in case it's updated from parent)
  useEffect(() => {
    setTitle(currentTask.title);
    setDescription(currentTask.description ?? "");
    setLevel(currentTask.level);
    setPriority(currentTask.priority ?? null);
    setTagsInput(currentTask.tags.join(", "));
    setError(null);
    setValidationErrors({});
  }, [currentTask.id, currentTask]);

  /**
   * Validate form fields
   */
  const validateForm = useCallback(() => {
    const errors: Record<string, string> = {};

    if (!title.trim()) {
      errors.title = "Title is required";
    }

    if (!description.trim()) {
      errors.description = "Description is required";
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  }, [title, description]);

  /**
   * Handle form submission
   */
  const handleSubmit = useCallback(async () => {
    // Clear previous error
    setError(null);

    // Validate form
    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);

    try {
      // Call the update_task command
      const result = await commands.updateTask(
        taskId,
        title.trim() !== currentTask.title ? title.trim() : null,
        description.trim() !== currentTask.description ? description.trim() : null,
        priority !== currentTask.priority ? priority : null
      );

      if (result.status === "error") {
        setError(result.error.message);
        return;
      }

      // Success - call the callback
      onSuccess();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to update task";
      setError(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  }, [taskId, title, description, priority, currentTask, validateForm, onSuccess]);

  /**
   * Handle cancel - reset form and close
   */
  const handleCancel = useCallback(() => {
    setTitle(currentTask.title);
    setDescription(currentTask.description ?? "");
    setLevel(currentTask.level);
    setPriority(currentTask.priority ?? null);
    setTagsInput(currentTask.tags.join(", "));
    setError(null);
    setValidationErrors({});
    onClose();
  }, [currentTask, onClose]);

  /**
   * Handle title change and clear error
   */
  const handleTitleChange = useCallback(
    (value: string) => {
      setTitle(value);
      setError(null);
      // Clear title validation error
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next.title;
        return next;
      });
    },
    []
  );

  /**
   * Handle description change and clear error
   */
  const handleDescriptionChange = useCallback(
    (value: string) => {
      setDescription(value);
      setError(null);
      // Clear description validation error
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next.description;
        return next;
      });
    },
    []
  );

  /**
   * Handle priority change and clear error
   */
  const handlePriorityChange = useCallback(
    (value: TaskPriority | null) => {
      setPriority(value);
      setError(null);
    },
    []
  );

  return (
    <FormModal
      isOpen={true}
      title="Edit Task"
      onClose={handleCancel}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      error={error}
      submitButtonText="Save Changes"
      preventCloseDuringSubmit={true}
      preventBackdropClickDuringSubmit={true}
    >
      <form className="flex flex-col gap-4">
        {/* Title field */}
        <FormField
          label="Title"
          required
          error={validationErrors.title}
          inputId="edit-task-title"
        >
          <input
            id="edit-task-title"
            type="text"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            disabled={isSubmitting}
            className={`w-full px-3 py-2 bg-background-primary border rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-primary ${
              validationErrors.title ? "border-error" : "border-border"
            } ${isSubmitting ? "opacity-50 cursor-not-allowed" : ""}`}
            placeholder="Enter task title"
          />
        </FormField>

        {/* Description field */}
        <FormField
          label="Description"
          required
          error={validationErrors.description}
          inputId="edit-task-description"
        >
          <textarea
            id="edit-task-description"
            value={description}
            onChange={(e) => handleDescriptionChange(e.target.value)}
            disabled={isSubmitting}
            rows={4}
            className={`w-full px-3 py-2 bg-background-primary border rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-primary resize-none ${
              validationErrors.description ? "border-error" : "border-border"
            } ${isSubmitting ? "opacity-50 cursor-not-allowed" : ""}`}
            placeholder="Enter task description"
          />
        </FormField>

        {/* Level field (read-only display) */}
        <FormField label="Level" inputId="edit-task-level">
          <div className="px-3 py-2 bg-background-tertiary border border-border rounded-md text-text-secondary">
            {level.charAt(0).toUpperCase() + level.slice(1)}
          </div>
        </FormField>

        {/* Priority field */}
        <FormField label="Priority" inputId="edit-task-priority">
          <select
            id="edit-task-priority"
            value={priority ?? "none"}
            onChange={(e) => handlePriorityChange((e.target.value === "none" ? null : e.target.value) as TaskPriority | null)}
            disabled={isSubmitting}
            className={`w-full px-3 py-2 bg-background-primary border border-border rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-primary ${
              isSubmitting ? "opacity-50 cursor-not-allowed" : ""
            }`}
          >
            <option value="none">None</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </FormField>

        {/* Tags field */}
        <FormField
          label="Tags"
          helpText="Enter tags separated by commas"
          inputId="edit-task-tags"
        >
          <input
            id="edit-task-tags"
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            disabled={isSubmitting}
            className={`w-full px-3 py-2 bg-background-primary border border-border rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-primary ${
              isSubmitting ? "opacity-50 cursor-not-allowed" : ""
            }`}
            placeholder="e.g., bug, ui, urgent"
          />
        </FormField>
      </form>
    </FormModal>
  );
}
