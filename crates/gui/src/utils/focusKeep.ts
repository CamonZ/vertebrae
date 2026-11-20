/**
 * Text inputs the user writes into (the chat composer, discussion and comment
 * composers) carry this attribute. They keep keyboard focus until a user
 * action moves it or they unmount; see `useKeepFocus` and the dev focus
 * tracer.
 */
export const FOCUS_KEEP_ATTRIBUTE = "data-focus-keep";

export const FOCUS_KEEP_SELECTOR = `[${FOCUS_KEEP_ATTRIBUTE}]`;

/** Spread onto a textarea that must keep focus while the user types. */
export const focusKeepProps = { [FOCUS_KEEP_ATTRIBUTE]: "" } as const;

export function isFocusKeepInput(
  element: Element | null | undefined
): element is HTMLTextAreaElement | HTMLInputElement {
  return (
    (element instanceof HTMLTextAreaElement ||
      element instanceof HTMLInputElement) &&
    element.hasAttribute(FOCUS_KEEP_ATTRIBUTE)
  );
}
