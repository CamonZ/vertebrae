import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  CONTEXT_SCOPE_LABEL,
  type ContextScopeId,
  type PaletteItem,
} from "./paletteModel";

/** One focused-area scope the palette offers, innermost first. */
export interface PaletteContextScope {
  id: ContextScopeId;
  label: string;
  items: readonly PaletteItem[];
}

/**
 * Builds a surface's scope items when ⌘K opens with focus at `target`
 * (inside the surface). A provider may contribute to several scopes, e.g.
 * the chat workspace adds side column entries to the focused section.
 */
export type PaletteScopeProvider = (
  target: Element
) => readonly PaletteContextScope[];

/** Marks an element whose subtree offers palette scopes. */
const PALETTE_SCOPE_ATTRIBUTE = "data-palette-scope";

const providers = new WeakMap<Element, { current: PaletteScopeProvider }>();

/**
 * Offer palette scopes while focus is inside `ref`'s element. The provider
 * runs only when the palette opens, so it can read the latest render state.
 */
export function usePaletteScope(
  ref: RefObject<HTMLElement | null>,
  provider: PaletteScopeProvider
) {
  const latest = useRef(provider);
  useLayoutEffect(() => {
    latest.current = provider;
  });
  const registered = useRef<HTMLElement | null>(null);
  // No dependencies: the element can mount after the owner (an early
  // return) or be replaced, so each commit re-checks which one to mark.
  useEffect(() => {
    const element = ref.current;
    if (element === registered.current) return;
    unregister(registered.current);
    registered.current = element;
    if (!element) return;
    providers.set(element, latest);
    element.setAttribute(PALETTE_SCOPE_ATTRIBUTE, "");
  });
  useEffect(
    () => () => {
      unregister(registered.current);
      registered.current = null;
    },
    []
  );
}

function unregister(element: HTMLElement | null) {
  if (!element) return;
  providers.delete(element);
  element.removeAttribute(PALETTE_SCOPE_ATTRIBUTE);
}

/** A context scope with its default label. */
export function contextScope(
  id: ContextScopeId,
  items: readonly PaletteItem[]
): PaletteContextScope {
  return { id, label: CONTEXT_SCOPE_LABEL[id], items };
}

/**
 * The scopes for focus at `target`: providers from the innermost element
 * outwards, with items for the same scope merged in that order. Scopes left
 * without items are dropped.
 */
function paletteScopesAt(target: Element | null): PaletteContextScope[] {
  const merged = new Map<ContextScopeId, PaletteContextScope>();
  let element = target?.closest(`[${PALETTE_SCOPE_ATTRIBUTE}]`) ?? null;
  while (element) {
    const provider = providers.get(element);
    for (const scope of provider?.current(target!) ?? []) {
      const previous = merged.get(scope.id);
      merged.set(
        scope.id,
        previous
          ? { ...previous, items: [...previous.items, ...scope.items] }
          : scope
      );
    }
    element =
      element.parentElement?.closest(`[${PALETTE_SCOPE_ATTRIBUTE}]`) ?? null;
  }
  return [...merged.values()].filter((scope) => scope.items.length > 0);
}

/** The scopes for focus at `target`, and the one ⌘K opens on. */
export function focusedPaletteScopes(
  target: Element | null = document.activeElement
) {
  const contexts = paletteScopesAt(target);
  return { contexts, initial: contexts[0]?.id ?? ("all" as const) };
}
