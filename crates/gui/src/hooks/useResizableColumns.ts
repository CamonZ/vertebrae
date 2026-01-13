import { useState, useCallback, useRef } from 'react';

/**
 * Column configuration with width
 */
export interface ColumnConfig {
  id: string;
  width: number;
  minWidth: number;
}

/**
 * Hook for managing resizable columns with localStorage persistence
 */
export function useResizableColumns(
  columnIds: string[],
  defaultWidths: Record<string, number>,
  minWidths: Record<string, number> = {}
) {
  const storageKey = `taskListColumnWidths-${columnIds.join(',')}`;

  // Initialize from localStorage or defaults
  const [columns, setColumns] = useState<Record<string, number>>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.warn('Failed to load column widths from localStorage', error);
    }
    return defaultWidths;
  });

  const resizeStartRef = useRef<{
    columnId: string;
    startX: number;
    startWidth: number;
  } | null>(null);

  /**
   * Handle mouse down on resize handle
   */
  const handleResizeStart = useCallback(
    (columnId: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      resizeStartRef.current = {
        columnId,
        startX: e.clientX,
        startWidth: columns[columnId],
      };

      document.addEventListener('mousemove', handleResizeMove);
      document.addEventListener('mouseup', handleResizeEnd);
    },
    [columns]
  );

  /**
   * Handle mouse move during resize
   */
  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!resizeStartRef.current) return;

    const { columnId, startX, startWidth } = resizeStartRef.current;
    const deltaX = e.clientX - startX;
    const newWidth = Math.max(
      minWidths[columnId] || 50,
      startWidth + deltaX
    );

    setColumns((prev) => {
      const updated = { ...prev, [columnId]: newWidth };
      // Persist to localStorage
      try {
        localStorage.setItem(storageKey, JSON.stringify(updated));
      } catch (error) {
        console.warn('Failed to save column widths to localStorage', error);
      }
      return updated;
    });
  }, [minWidths, storageKey]);

  /**
   * Handle mouse up after resize
   */
  const handleResizeEnd = useCallback(() => {
    resizeStartRef.current = null;
    document.removeEventListener('mousemove', handleResizeMove);
    document.removeEventListener('mouseup', handleResizeEnd);
  }, [handleResizeMove]);

  /**
   * Reset columns to default widths
   */
  const resetColumns = useCallback(() => {
    setColumns(defaultWidths);
    try {
      localStorage.removeItem(storageKey);
    } catch (error) {
      console.warn('Failed to clear column widths from localStorage', error);
    }
  }, [defaultWidths, storageKey]);

  return {
    columns,
    handleResizeStart,
    resetColumns,
  };
}
