import { create } from "zustand";
import type {
  PaletteItem,
  PaletteScope,
} from "../components/CommandPalette/paletteModel";

interface CommandPaletteState {
  open: boolean;
  /** Scope the palette opens with; the user can still switch tabs. */
  scope: PaletteScope;
  /**
   * Items from the focused surface (Changes), offered under their own scope
   * for this opening only; cleared when the palette closes.
   */
  contextItems: readonly PaletteItem[];
  openPalette: (
    scope?: PaletteScope,
    contextItems?: readonly PaletteItem[]
  ) => void;
  closePalette: () => void;
  togglePalette: (scope?: PaletteScope) => void;
}

const NO_ITEMS: readonly PaletteItem[] = [];

/**
 * Open state for the ⌘K palette, so page-level search affordances (the
 * Tasks toolbar, the board, the run console) open it pre-scoped instead of
 * keeping their own search boxes.
 */
export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  scope: "all",
  contextItems: NO_ITEMS,
  openPalette: (scope = "all", contextItems = NO_ITEMS) =>
    set({ open: true, scope, contextItems }),
  closePalette: () => set({ open: false, contextItems: NO_ITEMS }),
  togglePalette: (scope = "all") =>
    set((state) =>
      state.open
        ? { open: false, contextItems: NO_ITEMS }
        : { open: true, scope, contextItems: NO_ITEMS }
    ),
}));
