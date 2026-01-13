/**
 * ColumnResizer component provides a draggable handle for resizing table columns
 */
interface ColumnResizerProps {
  onResizeStart: (e: React.MouseEvent) => void;
}

export function ColumnResizer({ onResizeStart }: ColumnResizerProps) {
  return (
    <div
      className="absolute -right-1 top-0 h-full w-2 cursor-col-resize select-none"
      onMouseDown={onResizeStart}
      role="separator"
      aria-label="Column resize handle"
      aria-orientation="vertical"
    >
      {/* Thin line visible on hover only */}
      <div className="absolute left-1/2 top-1/4 h-1/2 w-px -translate-x-1/2 bg-border opacity-0 transition-opacity hover:opacity-100" />
    </div>
  );
}
