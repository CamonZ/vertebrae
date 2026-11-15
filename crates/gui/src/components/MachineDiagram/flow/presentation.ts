/** Live scene data. Deliberately outside the compiler and layout-worker input. */
export interface FlowPresentation {
  /** Host search decoration, outside geometric compilation. */
  readonly dimmed?: ReadonlySet<string>;
  /** Visible part counts require neutral full-scale parts without change notes;
   * region counts require a structurally reserved liveHeader. Accessible names
   * retain counts even when another label owns the visual slot. */
  readonly counts?: ReadonlyMap<string, { total: number; running: number }>;
  /** Host-owned stable test hooks per part id, outside geometric compilation. */
  readonly testIds?: ReadonlyMap<string, string>;
  readonly selected?: ReadonlySet<string>;
  readonly traced?: ReadonlySet<string>;
  readonly rails?: ReadonlySet<string>;
  /**
   * Rails between regions of a composite layout (workflow handoffs): drawn
   * heavier, with labels at `CROSS_LABEL_SIZE`, where the layout reserved room.
   */
  readonly handoffs?: ReadonlySet<string>;
  /** Pointer over a rail (a wide invisible hit area along its route). */
  readonly onHoverRail?: (id: string | null) => void;
  /** Traced rails relative to the trace: leaving it (`out`) or entering it (`in`). */
  readonly flow?: ReadonlyMap<string, "in" | "out">;
  readonly onActivateRegion?: (id: string) => void;
  readonly onHoverRegion?: (id: string | null) => void;
  readonly onFocusRegion?: (id: string | null) => void;
}

export function countDescription(count?: { total: number; running: number }) {
  return count && (count.total > 0 || count.running > 0)
    ? `${count.total} parked, ${count.running} active`
    : undefined;
}

/** Per-value titles for a live count, in the Map canvas chip vocabulary. */
export function countTitles(count?: {
  total: number;
  running: number;
}): string[] {
  if (!count) return [];
  return [
    ...(count.total > 0 ? [`${count.total} task(s)`] : []),
    ...(count.running > 0 ? [`${count.running} active`] : []),
  ];
}
