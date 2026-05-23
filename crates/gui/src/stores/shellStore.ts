import { create } from "zustand";
import type { ReactNode } from "react";

interface ShellState {
  /** Current page title — drives the right side of the header breadcrumb. */
  pageTitle: string;
  setPageTitle: (title: string) => void;

  /** Optional right-side header content (live counter, filter chips, etc.). */
  headerActions: ReactNode | null;
  setHeaderActions: (actions: ReactNode | null) => void;

  /**
   * Number of items currently demanding the user's attention (failed runs,
   * pending reviews, etc.). Drives the dot on the Operations sidebar icon.
   */
  needsAttentionCount: number;
  setNeedsAttentionCount: (count: number) => void;
}

/**
 * Cross-cutting UI state that the AppShell, Header, and Sidebar each read
 * but that individual pages own. Pages push their title/actions in an effect
 * via useShellHeader; the shell reads from this store to render.
 */
export const useShellStore = create<ShellState>((set) => ({
  pageTitle: "",
  setPageTitle: (pageTitle) => set({ pageTitle }),

  headerActions: null,
  setHeaderActions: (headerActions) => set({ headerActions }),

  needsAttentionCount: 0,
  setNeedsAttentionCount: (needsAttentionCount) => set({ needsAttentionCount }),
}));
