/** Live scene data. Deliberately outside the compiler and layout-worker input. */
export interface FlowPresentation {
  /** Visible part counts require neutral full-scale parts without change notes;
   * region counts require a structurally reserved liveHeader. Accessible names
   * retain counts even when another label owns the visual slot. */
  readonly counts?: ReadonlyMap<string, { total: number; running: number }>;
  readonly selected?: ReadonlySet<string>;
  readonly traced?: ReadonlySet<string>;
  readonly rails?: ReadonlySet<string>;
  readonly onActivateRegion?: (id: string) => void;
  readonly onHoverRegion?: (id: string | null) => void;
  readonly onFocusRegion?: (id: string | null) => void;
}

export function countDescription(count?: { total: number; running: number }) {
  return count && (count.total > 0 || count.running > 0)
    ? `${count.total} parked, ${count.running} active`
    : undefined;
}
