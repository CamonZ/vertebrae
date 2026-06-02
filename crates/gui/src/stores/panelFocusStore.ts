import { create } from "zustand";

/**
 * Tracks which floating "glass" panels are open and which one is focused, so a
 * single Escape can close the one the user is working in when several are open.
 *
 * `stack` is ordered oldest → newest; the LAST entry is the focused/topmost
 * panel. Panels register on open and unregister on close *or unmount* — the
 * latter is what prunes page-local panels (e.g. the Tasks-page task-detail
 * float) when you navigate away, while the globally-mounted chat persists.
 *
 * This store only arbitrates focus order. Each panel owns its own close
 * behaviour (see useGlassPanel); the store never holds component callbacks.
 */
export type GlassPanelId = string;

interface PanelFocusState {
  /** Open panels, oldest → newest. `at(-1)` is focused/topmost. */
  stack: GlassPanelId[];
  /** Mark a panel open; if already open, raise it to focused. */
  open: (id: GlassPanelId) => void;
  /** Mark a panel closed / unmounted. */
  close: (id: GlassPanelId) => void;
  /** Raise an already-open panel to focused (on user interaction). */
  focus: (id: GlassPanelId) => void;
  /** Reset — test seam. */
  reset: () => void;
}

const raise = (stack: GlassPanelId[], id: GlassPanelId): GlassPanelId[] => [
  ...stack.filter((p) => p !== id),
  id,
];

export const usePanelFocusStore = create<PanelFocusState>((set) => ({
  stack: [],
  open: (id) => set((s) => ({ stack: raise(s.stack, id) })),
  close: (id) => set((s) => ({ stack: s.stack.filter((p) => p !== id) })),
  focus: (id) =>
    set((s) =>
      s.stack[s.stack.length - 1] === id ? s : { stack: raise(s.stack, id) }
    ),
  reset: () => set({ stack: [] }),
}));

/** The focused (topmost) panel id, or null if none are open. */
export const selectFocusedPanel = (s: PanelFocusState): GlassPanelId | null =>
  s.stack[s.stack.length - 1] ?? null;
