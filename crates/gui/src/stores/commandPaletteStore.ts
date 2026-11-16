import { create } from "zustand";
import type { PaletteScope } from "../components/CommandPalette/paletteModel";

interface CommandPaletteState {
  open: boolean;
  /** Scope the palette opens with; the user can still switch tabs. */
  scope: PaletteScope;
  openPalette: (scope?: PaletteScope) => void;
  closePalette: () => void;
  togglePalette: (scope?: PaletteScope) => void;
}

/**
 * Open state for the ⌘K palette, so page-level search affordances (the
 * Tasks toolbar, the board, the run console) open it pre-scoped instead of
 * keeping their own search boxes.
 */
export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  scope: "all",
  openPalette: (scope = "all") => set({ open: true, scope }),
  closePalette: () => set({ open: false }),
  togglePalette: (scope = "all") =>
    set((state) => (state.open ? { open: false } : { open: true, scope })),
}));
