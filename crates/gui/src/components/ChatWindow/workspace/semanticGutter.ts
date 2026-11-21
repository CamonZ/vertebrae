import type { SemanticLabel } from "./semanticHunks";

const MARKER = "data-semantic-indicator";

export const SEMANTIC_GUTTER_CSS = `
/* Reserve a slot before the line number, clear of the diff bar. */
[data-gutter] [data-column-number] {
  padding-inline-start: calc(2ch + 16px);
}
[data-disable-line-numbers] [data-gutter] [data-column-number] {
  min-width: 24px;
  padding-inline-start: 0;
}
[${MARKER}] {
  appearance: none;
  position: absolute;
  inset-inline-start: 6px;
  inset-block-start: 0;
  inline-size: 16px;
  block-size: 1lh;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--color-fg-soft, var(--diffs-fg));
  cursor: pointer;
  z-index: 2;
}
[${MARKER}]::before {
  content: "";
  width: 6px;
  height: 6px;
  border: 1px solid currentColor;
  border-radius: 50%;
}
[${MARKER}]:hover,
[${MARKER}][aria-expanded="true"] {
  color: var(--color-accent, var(--diffs-modified-base));
}
[${MARKER}][aria-expanded="true"]::before {
  background: currentColor;
}
[${MARKER}]:focus-visible {
  outline: 1px solid currentColor;
  outline-offset: -2px;
  border-radius: 4px;
}
`;

interface GutterDiff {
  getLineIndex(line: number, side: SemanticLabel["side"]): readonly number[] | undefined;
}

/** Pierre owns the virtual rows. Decorate the rows it has mounted and
 * reconcile again whenever it expands, redraws or recycles them. */
export function syncSemanticGutter(
  root: ShadowRoot,
  diff: GutterDiff,
  labels: readonly SemanticLabel[],
  active: SemanticLabel | undefined,
  toggle: (label: SemanticLabel) => void,
  focus?: SemanticLabel
): boolean {
  const stale = new Set(root.querySelectorAll<HTMLButtonElement>(`[${MARKER}]`));
  let focused = false;
  for (const label of labels) {
    const index = diff.getLineIndex(label.lineNumber, label.side)?.join(",");
    if (index === undefined) continue;
    const row = root.querySelector(
      `[data-code][data-${label.side}] [data-gutter] [data-column-number][data-line-index="${index}"], ` +
        `[data-code][data-unified] [data-gutter] [data-column-number][data-line-index="${index}"]`
    );
    if (!row) continue;

    const existing = row.querySelector<HTMLButtonElement>(`[${MARKER}]`);
    const button = existing ?? root.ownerDocument.createElement("button");
    if (!existing) {
      button.type = "button";
      button.setAttribute(MARKER, "");
      // Keep Pierre's line-selection handlers out of this control.
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
      row.append(button);
    }
    stale.delete(button);
    const scope = label.scope.at(-1)?.name;
    const name = `Semantic details for ${label.side === "deletions" ? "old" : "new"} line ${label.lineNumber}${scope ? ` in ${scope}` : ""}`;
    button.setAttribute("aria-label", name);
    button.title = name;
    button.setAttribute("aria-expanded", String(label === active));
    button.onclick = (event) => {
      event.stopPropagation();
      toggle(label);
    };
    if (label === focus) {
      button.focus({ preventScroll: true });
      focused = true;
    }
  }
  for (const button of stale) button.remove();
  return focused;
}
