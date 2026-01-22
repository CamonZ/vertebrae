import { useState, useCallback } from 'react';
import { commands } from '../bindings';
import { useTaskStore } from '../stores';

/**
 * Hook for deleting a task with confirmation state management.
 *
 * Provides delete functionality with:
 * - Confirmation dialog state (open/closed)
 * - Cascade delete option (delete children or orphan them)
 * - Loading and error states
 * - Automatic UI store updates after successful deletion
 *
 * @param taskId - The task ID to delete
 * @returns Object containing delete state and handlers
 */
export function useDeleteTask(taskId: string | null | undefined) {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [cascade, setCascade] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { clearSelection } = useTaskStore();

  const openDeleteDialog = useCallback(() => {
    setIsDeleteDialogOpen(true);
    setDeleteError(null);
    setCascade(false);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    setIsDeleteDialogOpen(false);
    setDeleteError(null);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!taskId) return;

    setIsDeleting(true);
    setDeleteError(null);

    try {
      const result = await commands.deleteTask(taskId, cascade);
      if (result.status === 'ok') {
        // Deletion successful - clear selection and close dialog
        clearSelection();
        setIsDeleteDialogOpen(false);
      } else {
        setDeleteError(result.error.message);
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete task');
    } finally {
      setIsDeleting(false);
    }
  }, [taskId, cascade, clearSelection]);

  return {
    isDeleteDialogOpen,
    openDeleteDialog,
    closeDeleteDialog,
    cascade,
    setCascade,
    isDeleting,
    deleteError,
    confirmDelete,
  };
}
