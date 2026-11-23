import { create } from "zustand";
import type { PaletteScope } from "../components/CommandPalette/paletteModel";
import type { PaletteContextScope } from "../components/CommandPalette/paletteScopes";

interface CommandPaletteState {
  open: boolean;
  /** Scope the palette opens with; the user can still switch tabs. */
  scope: PaletteScope;
  /**
   * Scopes of the focused area (This chat, Changes, Discussions, Background
   * tasks), innermost first, offered for this opening only; cleared when
   * the palette closes.
   */
  contexts: readonly PaletteContextScope[];
  openPalette: (
    scope?: PaletteScope,
    contexts?: readonly PaletteContextScope[]
  ) => void;
  closePalette: () => void;
  togglePalette: (
    scope?: PaletteScope,
    contexts?: readonly PaletteContextScope[]
  ) => void;
}

const NO_CONTEXTS: readonly PaletteContextScope[] = [];

/**
 * Open state for the ⌘K palette, so page-level search affordances (the
 * Tasks toolbar, the board, the run console) open it pre-scoped instead of
 * keeping their own search boxes.
 */
export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  scope: "all",
  contexts: NO_CONTEXTS,
  openPalette: (scope = "all", contexts = NO_CONTEXTS) =>
    set({ open: true, scope, contexts }),
  closePalette: () => set({ open: false, contexts: NO_CONTEXTS }),
  togglePalette: (scope = "all", contexts = NO_CONTEXTS) =>
    set((state) =>
      state.open
        ? { open: false, contexts: NO_CONTEXTS }
        : { open: true, scope, contexts }
    ),
}));
