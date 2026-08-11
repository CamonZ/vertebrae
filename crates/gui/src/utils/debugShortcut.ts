export function isDebugConsoleShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "code" | "key">
): boolean {
  const key = event.key.toLowerCase();
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    (event.code === "KeyD" || key === "d")
  );
}
