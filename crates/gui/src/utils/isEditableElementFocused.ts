/**
 * True when the active element is a text-editing control (input, textarea, or a
 * contenteditable node). Used by floating panels to decline an Escape keypress
 * so a field's own Escape-to-cancel wins over closing the whole panel.
 */
export function isEditableElementFocused(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable
  );
}
