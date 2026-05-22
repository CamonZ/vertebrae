export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tagName = target.tagName.toLowerCase();
  if (tagName === "textarea" || tagName === "select") return true;
  if (tagName !== "input") return false;

  const type = target.getAttribute("type")?.toLowerCase() ?? "text";
  return !["button", "checkbox", "radio", "range", "submit"].includes(type);
}
