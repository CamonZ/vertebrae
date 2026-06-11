import { useState, useCallback } from "react";
import { commands } from "../bindings";
import { removeTaskFromQueryCache } from "../query";

interface UseDeleteTaskOptions {
  onDeleted?: () => void;
}

/**
 * Hook for deleting a task with confirmation state management.
 *
 * Provides delete functionality with:
 * - Confirmation dialog state (open/closed)
 * - Cascade delete option (delete children or orphan them)
 * - Loading and error states
 * - Immediate cache removal on success (idempotent with the websocket event)
 *
 * @param taskId - The task ID to delete
 * @returns Object containing delete state and handlers
 */
export function useDeleteTask(
  taskId: string | null | undefined,
  options: UseDeleteTaskOptions = {}
) {
  const { onDeleted } = options;
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [cascade, setCascade] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
      if (result.status === "ok") {
        removeTaskFromQueryCache(taskId);
        setIsDeleteDialogOpen(false);
        onDeleted?.();
      } else {
        setDeleteError(result.error.message);
      }
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete task"
      );
    } finally {
      setIsDeleting(false);
    }
  }, [taskId, cascade, onDeleted]);

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
