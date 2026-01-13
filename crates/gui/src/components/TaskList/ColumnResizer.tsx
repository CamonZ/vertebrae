/**
 * ColumnResizer component provides a draggable handle for resizing table columns
 */
interface ColumnResizerProps {
  onResizeStart: (e: React.MouseEvent) => void;
}

export function ColumnResizer({ onResizeStart }: ColumnResizerProps) {
  return (
    <div
      className="group absolute right-0 top-0 h-full w-1 cursor-col-resize select-none bg-transparent transition-colors hover:bg-primary/50"
      onMouseDown={onResizeStart}
      role="separator"
      aria-label="Column resize handle"
      aria-orientation="vertical"
    >
      {/* Visual indicator on hover */}
      <div className="absolute right-0 top-1/2 h-4 w-1 -translate-y-1/2 rounded-sm bg-primary/30 opacity-0 transition-opacity group-hover:opacity-100" />
    </div>
  );
}
