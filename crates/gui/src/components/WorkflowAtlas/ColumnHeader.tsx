/**
 * One phase-column header on the Workflow Atlas / Map face.
 *
 * Absolutely placed over a `CondensedColumn` (from `layoutCondensed`); shows the
 * value-stream phase label and member count. It is part of the MAP chrome and is
 * not rendered by the P4 graph-only view — it is built here so P5 can drop it
 * onto the map layer without a new component.
 *
 * Ported from docs/design/workflow-views.jsx (`.al-stagehd`).
 */
import type { CondensedColumn } from "./layout/types";

export interface ColumnHeaderProps {
  column: CondensedColumn;
  /** Left edge / width of the first member card (header aligns to the column). */
  left: number;
  width: number;
  top?: number;
}

export function ColumnHeader({ column, left, width, top = 8 }: ColumnHeaderProps) {
  const label = column.phase || `Layer ${column.index + 1}`;
  return (
    <div className="al-stagehd" style={{ left, top, width }}>
      {label}
      <span className="n">{column.members.length}</span>
      <span className="ln" />
    </div>
  );
}
