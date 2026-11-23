import { useCallback, useEffect, useRef, type RefObject } from "react";
import { commands } from "../../bindings";
import {
  openingSection,
  useChatSideColumnStore,
  type SideColumnView,
  type SideSection,
} from "../../stores/chatSideColumnStore";
import type { SideColumnControls } from "./ChatPaneList";
import { CHAT_AREA_ATTRIBUTE } from "./chatAreas";
import { dirtyPaths } from "./workspace/documentStore";

/**
 * A chat's side column controls (db5160ff): which section shows, and the
 * header, switcher and shortcut actions on it. Open and section live in the
 * per-chat store, so they survive tab switches and unmounting.
 */
export function useChatSideColumn({
  sessionId,
  view,
  worktreePath,
  isMainCheckout,
  counts,
  register,
  panel,
  active,
  evidenceShown,
  onDirty,
  onClose,
  onSelect,
}: {
  sessionId: string;
  /** The chat's column in the store (`useSideColumnView`). */
  view: SideColumnView;
  /** The checkout Changes would show; Changes is unavailable without one. */
  worktreePath: string | null | undefined;
  /** The main checkout's Changes compares other refs, so it opens clean. */
  isMainCheckout: boolean;
  /** What each section holds; the column opens on one with content. */
  counts: Readonly<Record<SideSection, number>>;
  /** Hands ⌘⇧B and ⌃⌘1–3 the controls while this chat is in front. */
  register?: (controls: SideColumnControls | null) => void;
  /** The column; a section shown by a user action takes the keyboard. */
  panel: RefObject<HTMLElement | null>;
  /** The foreground pane; a check that lands after it changed is dropped. */
  active: boolean;
  /** Source evidence holds the column's slot meanwhile. */
  evidenceShown: boolean;
  /** Leaving Changes with unsaved documents: ask about these first. */
  onDirty(paths: string[]): void;
  /** The column is about to close. */
  onClose(): void;
  /** `section` is about to show. */
  onSelect(section: SideSection): void;
}) {
  const show = useChatSideColumnStore((state) => state.show);
  const close = useChatSideColumnStore((state) => state.close);
  const changesShown =
    view.open && view.section === "changes" && !!worktreePath;
  const shownSection: SideSection | null =
    view.open && !evidenceShown && (view.section !== "changes" || changesShown)
      ? view.section
      : null;

  const available = useCallback(
    (section: SideSection) => section !== "changes" || !!worktreePath,
    [worktreePath]
  );

  /** Close the column; open documents with unsaved edits ask first. */
  const requestClose = useCallback(() => {
    const dirty = changesShown && worktreePath ? dirtyPaths(worktreePath) : [];
    if (dirty.length) return onDirty(dirty);
    onClose();
    close(sessionId);
  }, [changesShown, worktreePath, onDirty, onClose, close, sessionId]);

  /** Keys go to the shown section's content once it is on screen. */
  const focusSection = useCallback(
    () =>
      requestAnimationFrame(() =>
        panel.current
          ?.querySelector<HTMLElement>(`[${CHAT_AREA_ATTRIBUTE}]`)
          ?.focus({ preventScroll: true })
      ),
    [panel]
  );

  /**
   * Show a section; open documents keep their drafts in the store. `focus`:
   * a user switching sections, whose ↑/↓ then move through its content.
   */
  const select = useCallback(
    (section: SideSection, focus = false) => {
      if (!available(section)) return;
      onSelect(section);
      show(sessionId, section);
      if (focus) focusSection();
    },
    [available, onSelect, show, sessionId, focusSection]
  );

  /** A header toggle: show its section, or close the column showing it. */
  const toggle = useCallback(
    (section: SideSection) =>
      shownSection === section ? requestClose() : select(section, true),
    [shownSection, requestClose, select]
  );

  // A worktree check that lands after the chat left the foreground (or
  // unmounted, as hidden tabs do) is dropped.
  const pendingCheck = useRef(false);
  const inFront = useRef(active);
  useEffect(() => {
    inFront.current = active;
    return () => {
      inFront.current = false;
    };
  }, [active]);
  /**
   * ⌘⇧B on a chat with nothing to show yet: check its worktree on demand,
   * including committed branch changes against the same default baseline as
   * the Changes view, and open Changes when there are any.
   */
  const openChangesIfAny = useCallback((): boolean => {
    if (!worktreePath) return false;
    if (isMainCheckout) {
      select("changes", true);
      return true;
    }
    if (pendingCheck.current) return true;
    pendingCheck.current = true;
    const comparison = {
      base: null,
      target: { kind: "working_tree" as const },
      merge_base: true,
    };
    void commands
      .loadWorktreeChanges(worktreePath, comparison)
      .then((result) => {
        if (
          inFront.current &&
          result.status === "ok" &&
          result.data.files.length > 0
        ) {
          show(sessionId, "changes");
          focusSection();
        }
      })
      .catch(() => {
        // A failed check cannot establish that this worktree has changes.
      })
      .finally(() => {
        pendingCheck.current = false;
      });
    return true;
  }, [worktreePath, isMainCheckout, select, show, sessionId, focusSection]);

  /** ⌘⇧B: close the column, or open it where it was or on content. */
  const toggleColumn = useCallback((): boolean => {
    if (shownSection) {
      requestClose();
      return true;
    }
    const hasContent = Object.values(counts).some((count) => count > 0);
    if (!view.section && !hasContent) return openChangesIfAny();
    const section = openingSection(view.section, counts, available);
    if (!section) return false;
    select(section, true);
    return true;
  }, [shownSection, counts, view.section, available, requestClose, select, openChangesIfAny]);

  /** ⌃⌘1–3: a header toggle from the keyboard. */
  const toggleSection = useCallback(
    (section: SideSection): boolean => {
      if (!available(section)) return false;
      toggle(section);
      return true;
    },
    [available, toggle]
  );

  useEffect(() => {
    if (!register || !active) return;
    register({ toggle: toggleColumn, toggleSection });
    return () => register(null);
  }, [register, active, toggleColumn, toggleSection]);

  return {
    changesShown,
    shownSection,
    available,
    requestClose,
    select,
    toggle,
  };
}
