import { createContext } from "react";

/**
 * Workspace chrome the pane header offers when the compact panel has no tab
 * strip row of its own: the history and expand controls move into the
 * header's overflow menu so the panel has a single chrome row.
 */
export interface WorkspaceChrome {
  /** The expanded workspace owns these controls on its tab strip. */
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleHistory: () => void;
}

export const WorkspaceChromeContext = createContext<WorkspaceChrome | null>(
  null
);
