import { useCallback, useMemo, type Dispatch, type SetStateAction } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { SelectedLineRange } from "@pierre/diffs";
import type { ComparisonEndpoint } from "../bindings";

/**
 * Per-chat side column (decision 49d12c2c §1, §8): one column per chat with
 * a Changes · Discussions · Background tasks switcher. Hidden chats unmount,
 * so the column's view state lives here, keyed by session, rather than in
 * the chat's component state. Runtime only; forgotten with the chat's other
 * view memory (`forgetChatView`).
 */
export type SideSection = "changes" | "discussions" | "background";

export const SIDE_SECTIONS: readonly SideSection[] = [
  "changes",
  "discussions",
  "background",
];

export const SIDE_SECTION_LABEL: Record<SideSection, string> = {
  changes: "Changes",
  discussions: "Discussions",
  background: "Background tasks",
};

export type DiffCursor = { path: string; range: SelectedLineRange } | null;

/**
 * What a chat's Changes shows for one checkout: owned here, not by the
 * view, so it is where the view left it when it mounts again.
 */
export interface ChangesViewMemory {
  activePath: string | null;
  base: ComparisonEndpoint | null;
  target: ComparisonEndpoint;
  /** The keyboard line cursor (and its selection). */
  cursor: DiffCursor;
  /** The Review rail (the linked PR's GitHub threads) is open beside the diff. */
  reviewOpen: boolean;
}

export interface SideColumnView {
  open: boolean;
  /** The section last shown; the column reopens on it. */
  section: SideSection | null;
  /** Changes memory per checkout: a chat can browse more than one. */
  changes: Readonly<Record<string, ChangesViewMemory>>;
}

export const CLOSED_SIDE_COLUMN: SideColumnView = {
  open: false,
  section: null,
  changes: {},
};

/**
 * The available section `offset` steps from `from`, wrapping and skipping
 * unavailable ones; from no section, the first (or last) available one.
 */
export function cycleSection(
  from: SideSection | null,
  offset: -1 | 1,
  available: (section: SideSection) => boolean = () => true
): SideSection | null {
  const count = SIDE_SECTIONS.length;
  let at = from ? SIDE_SECTIONS.indexOf(from) : offset === 1 ? -1 : count;
  for (let step = 0; step < count; step++) {
    at = (at + offset + count) % count;
    if (available(SIDE_SECTIONS[at])) return SIDE_SECTIONS[at];
  }
  return null;
}

/**
 * Where the column opens: its last section when that is still available,
 * else the first with content, else the first available one.
 */
export function openingSection(
  last: SideSection | null,
  counts: Readonly<Record<SideSection, number>>,
  available: (section: SideSection) => boolean = () => true
): SideSection | null {
  if (last && available(last)) return last;
  return (
    SIDE_SECTIONS.find((section) => available(section) && counts[section] > 0) ??
    SIDE_SECTIONS.find(available) ??
    null
  );
}

interface SideColumnState {
  bySession: Readonly<Record<string, SideColumnView>>;
  show(sessionId: string, section: SideSection): void;
  close(sessionId: string): void;
  /** Update a checkout's Changes view; unchanged fields leave state alone. */
  saveChanges(
    sessionId: string,
    worktreePath: string,
    patch:
      | Partial<ChangesViewMemory>
      | ((current: ChangesViewMemory) => Partial<ChangesViewMemory>)
  ): void;
  forget(sessionId?: string): void;
}

export const NO_CHANGES_MEMORY: ChangesViewMemory = {
  activePath: null,
  base: null,
  target: { kind: "working_tree" },
  cursor: null,
  reviewOpen: false,
};

function viewOf(
  state: Pick<SideColumnState, "bySession">,
  sessionId: string
): SideColumnView {
  return state.bySession[sessionId] ?? CLOSED_SIDE_COLUMN;
}

export const useChatSideColumnStore = create<SideColumnState>((set) => ({
  bySession: {},
  show: (sessionId, section) =>
    set((state) => {
      const view = viewOf(state, sessionId);
      if (view.open && view.section === section) return state;
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...view, open: true, section },
        },
      };
    }),
  close: (sessionId) =>
    set((state) => {
      const view = viewOf(state, sessionId);
      if (!view.open) return state;
      return {
        bySession: { ...state.bySession, [sessionId]: { ...view, open: false } },
      };
    }),
  saveChanges: (sessionId, worktreePath, patch) =>
    set((state) => {
      const view = viewOf(state, sessionId);
      const current = view.changes[worktreePath] ?? NO_CHANGES_MEMORY;
      const changes = typeof patch === "function" ? patch(current) : patch;
      const keys = Object.keys(changes) as (keyof ChangesViewMemory)[];
      if (keys.every((key) => current[key] === changes[key])) return state;
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            ...view,
            changes: {
              ...view.changes,
              [worktreePath]: { ...current, ...changes },
            },
          },
        },
      };
    }),
  forget: (sessionId) =>
    set((state) => {
      if (sessionId === undefined) return { bySession: {} };
      if (!(sessionId in state.bySession)) return state;
      const bySession = { ...state.bySession };
      delete bySession[sessionId];
      return { bySession };
    }),
}));

export function useSideColumnView(sessionId: string): SideColumnView {
  return useChatSideColumnStore((state) => viewOf(state, sessionId));
}

/** One chat's Changes of one checkout. */
export interface ChangesKey {
  sessionId: string;
  worktreePath: string;
}

function memoryOf(state: Pick<SideColumnState, "bySession">, key: ChangesKey) {
  return (
    viewOf(state, key.sessionId).changes[key.worktreePath] ?? NO_CHANGES_MEMORY
  );
}

/**
 * A chat's Changes view of one checkout, without the line cursor: a cursor
 * move re-renders only the diff that reads it (`useChangesCursor`).
 */
export function useChangesView(
  key: ChangesKey
): Omit<ChangesViewMemory, "cursor"> {
  return useChatSideColumnStore(
    useShallow((state) => {
      const { base, target, activePath, reviewOpen } = memoryOf(state, key);
      return { base, target, activePath, reviewOpen };
    })
  );
}

/** The line cursor of a chat's Changes, as a state pair. */
export function useChangesCursor({
  sessionId,
  worktreePath,
}: ChangesKey): readonly [DiffCursor, Dispatch<SetStateAction<DiffCursor>>] {
  const cursor = useChatSideColumnStore(
    (state) => memoryOf(state, { sessionId, worktreePath }).cursor
  );
  const save = useChatSideColumnStore((state) => state.saveChanges);
  const setCursor = useCallback(
    (update: SetStateAction<DiffCursor>) =>
      save(sessionId, worktreePath, (current) => ({
        cursor: typeof update === "function" ? update(current.cursor) : update,
      })),
    [save, sessionId, worktreePath]
  );
  return useMemo(() => [cursor, setCursor] as const, [cursor, setCursor]);
}
