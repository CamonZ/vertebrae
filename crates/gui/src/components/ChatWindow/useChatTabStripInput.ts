/**
 * Input handling for the chat tab strip (ticket 736f94f3): width-driven
 * capacity, roving-tabindex keyboard focus, and pointer drag to reorder.
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { ChatTabModel } from "./chatTabs";

/** Tabs narrower than this go to the overflow menu. */
const MIN_TAB_WIDTH = 112;
/** Room kept beside the tabs for the "+N" menu and the new-chat button. */
const TAB_CONTROLS_WIDTH = 88;
/** Pointer travel before a press on a tab becomes a drag. */
const DRAG_THRESHOLD = 4;

/**
 * How many tabs fit inline. Measures the room the tabs may take, not the
 * tabs themselves: a tablist sized by its content would never grow back
 * after overflowing. Before the first measurement every tab fits. Mount it
 * with the tab area: the node is read once, on mount.
 */
export function useTabCapacity(tabCount: number): {
  tabAreaRef: RefObject<HTMLDivElement | null>;
  capacity: number;
} {
  const tabAreaRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = tabAreaRef.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const capacity =
    width > 0
      ? Math.floor((width - TAB_CONTROLS_WIDTH) / MIN_TAB_WIDTH)
      : tabCount;
  return { tabAreaRef, capacity };
}

interface TabFocusOptions {
  tabs: readonly ChatTabModel[];
  tablistRef: RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
  onEnterChat: (id: string) => void;
  onClose: (id: string) => void;
}

/**
 * Roving-tabindex keys for the tablist. Keeps keyboard focus on the tab the
 * user is driving across re-renders: reordering moves the DOM node, and
 * activation may change which tabs fit.
 */
export function useTabKeyboardFocus({
  tabs,
  tablistRef,
  onSelect,
  onEnterChat,
  onClose,
}: TabFocusOptions) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusTarget = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = focusTarget.current;
    if (!id) return;
    const node = tabRefs.current.get(id);
    if (node && document.activeElement !== node) node.focus();
  });

  const selectFromKeyboard = (id: string) => {
    focusTarget.current = id;
    onSelect(id);
    tabRefs.current.get(id)?.focus();
  };

  /** Clicks and Enter hand the keyboard to the chat itself. */
  const enterChat = (id: string) => {
    focusTarget.current = null;
    onEnterChat(id);
  };

  const closeFromKeyboard = (at: number) => {
    const last = tabs.length - 1;
    // Focus follows to the chat that takes the closed tab's place.
    const neighbour = tabs[at === last ? at - 1 : at + 1];
    onClose(tabs[at].id);
    focusTarget.current = neighbour.id;
  };

  const onTabKeyDown = (event: ReactKeyboardEvent, id: string) => {
    // Modified keys belong to the workspace shortcuts (e.g. ⌘⌥⇧← moves).
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const at = tabs.findIndex((tab) => tab.id === id);
    const last = tabs.length - 1;
    const target: Record<string, number> = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    };
    if (event.key in target) {
      event.preventDefault();
      selectFromKeyboard(tabs[target[event.key]].id);
    } else if (event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault();
      enterChat(id);
    } else if (
      (event.key === "Delete" || event.key === "Backspace") &&
      tabs.length > 1
    ) {
      event.preventDefault();
      closeFromKeyboard(at);
    }
  };

  const registerTab = (id: string) => (node: HTMLButtonElement | null) => {
    if (node) tabRefs.current.set(id, node);
    else tabRefs.current.delete(id);
  };

  const onTabFocus = (id: string) => {
    focusTarget.current = id;
  };

  const onTabBlur = (event: ReactFocusEvent) => {
    // Leaving the strip ends keyboard tab tracking.
    if (!tablistRef.current?.contains(event.relatedTarget as Node | null)) {
      focusTarget.current = null;
    }
  };

  return {
    tabRefs,
    registerTab,
    onTabKeyDown,
    onTabFocus,
    onTabBlur,
    enterChat,
  };
}

interface TabDragOptions {
  /** Inline tabs in strip order. */
  shown: readonly ChatTabModel[];
  /** Tabs in the "+N" menu, in strip order. */
  overflow: readonly ChatTabModel[];
  tabCount: number;
  tabRefs: RefObject<Map<string, HTMLButtonElement>>;
  onMoveBefore: (id: string, beforeId: string | null) => void;
}

/**
 * Pointer drag to reorder; a press that never travels is a click. Drop
 * targets are tab ids, so inline and overflow positions never mix.
 */
export function useTabDrag({
  shown,
  overflow,
  tabCount,
  tabRefs,
  onMoveBefore,
}: TabDragOptions) {
  const drag = useRef<{
    id: string;
    x: number;
    pointerId: number;
    moved: boolean;
  } | null>(null);
  /** Where a drop would land: before this inline tab, or past the last (null). */
  const [drop, setDrop] = useState<{ beforeId: string | null } | null>(null);
  // Set by a finished drag. Pointer capture retargets the click that follows
  // to the tablist, so the tablist swallows it in the capture phase.
  const suppressClick = useRef(false);
  const lastShownId = shown[shown.length - 1]?.id;

  const dropBeforeAt = (clientX: number): string | null => {
    const before = shown.find((tab) => {
      const rect = tabRefs.current.get(tab.id)?.getBoundingClientRect();
      return rect && clientX < rect.left + rect.width / 2;
    });
    return before?.id ?? null;
  };

  const onTabPointerDown = (event: ReactPointerEvent, id: string) => {
    suppressClick.current = false;
    if (event.button !== 0 || tabCount <= 1) return;
    drag.current = {
      id,
      x: event.clientX,
      pointerId: event.pointerId,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.moved) {
      if (Math.abs(event.clientX - current.x) < DRAG_THRESHOLD) return;
      current.moved = true;
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    }
    setDrop({ beforeId: dropBeforeAt(event.clientX) });
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    const current = drag.current;
    drag.current = null;
    setDrop(null);
    if (!current?.moved) return;
    event.preventDefault();
    const beforeId = dropBeforeAt(event.clientX);
    if (beforeId !== null) {
      onMoveBefore(current.id, beforeId);
    } else if (current.id !== lastShownId) {
      // Past the last inline tab is where the "+N" tabs begin: land in front
      // of the first hidden one, not after every chat.
      onMoveBefore(current.id, overflow[0]?.id ?? null);
    }
    // The click that follows a drag must not select.
    suppressClick.current = true;
  };

  const onPointerCancel = () => {
    drag.current = null;
    setDrop(null);
  };

  const onClickCapture = (event: ReactMouseEvent) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.stopPropagation();
  };

  /** Drop-indicator attributes for an inline tab. */
  const dropMarker = (id: string) => ({
    "data-drop-before": drop?.beforeId === id ? "" : undefined,
    "data-drop-after":
      drop && drop.beforeId === null && id === lastShownId ? "" : undefined,
  });

  return {
    onTabPointerDown,
    dropMarker,
    tablistHandlers: {
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClickCapture,
    },
  };
}
