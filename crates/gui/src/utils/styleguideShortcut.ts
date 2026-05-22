export const STYLEGUIDE_SHORTCUT = {
  key: "0",
  code: "Digit0",
  label: "Ctrl+Alt+Cmd+Shift+0",
} as const;

export function isStyleguideShortcut(event: KeyboardEvent): boolean {
  return (
    event.code === STYLEGUIDE_SHORTCUT.code &&
    event.metaKey &&
    event.altKey &&
    event.shiftKey &&
    event.ctrlKey
  );
}
